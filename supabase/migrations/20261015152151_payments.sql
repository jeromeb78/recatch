-- Payments: the processor behind a store (Stripe), used as the source of truth for what was charged, refunded and paid in
-- fees. Store orders (WooCommerce) still say what was sold; the app matches each Stripe charge to its order by the
-- transaction id WooCommerce saves, or the order number Stripe keeps in the charge's metadata.
-- No card or customer details are stored.

-- How a store order was paid, so it can be matched to its Stripe charge.
alter table public.sales_orders add column if not exists payment_method text;
alter table public.sales_orders add column if not exists payment_ref text;
create index if not exists sales_orders_payment_ref_idx on public.sales_orders (user_id, payment_ref);

create table public.payment_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  business_id     uuid references public.businesses (id) on delete set null,
  provider        text not null default 'stripe' check (provider in ('stripe')),
  name            text not null check (length(trim(name)) between 1 and 80),
  livemode        boolean not null default true,
  -- Restricted API key, encrypted in Vault (service role only).
  secret_id       uuid,
  status          text not null default 'active' check (status in ('active', 'error')),
  last_error      text,
  last_synced_at  timestamptz,
  synced_through  timestamptz, -- incremental syncs look at charges and refunds since this time
  backfill_cursor text,        -- history import position (a charge id); 'done' once all history is in
  created_at      timestamptz not null default now()
);
create index payment_accounts_user_idx on public.payment_accounts (user_id);

create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  account_id     uuid not null references public.payment_accounts (id) on delete cascade,
  external_id    text not null,  -- ch_… / py_…
  payment_intent text,           -- pi_…
  paid_at        timestamptz not null,
  payment_date   date not null,
  status         text not null check (status in ('succeeded', 'pending', 'failed')),
  currency       text not null default 'USD',
  amount         numeric(12, 2) not null default 0, -- charged, including sales tax and shipping
  refunded       numeric(12, 2) not null default 0,
  fee            numeric(12, 2) not null default 0, -- Stripe's processing fee
  net            numeric(12, 2) not null default 0,
  disputed       boolean not null default false,
  description    text,
  order_ref      text,           -- the store's order id from the charge metadata
  site_url       text,           -- the store the charge came from, when the plugin records it
  updated_at     timestamptz not null default now(),
  unique (account_id, external_id)
);
create index payments_user_date_idx on public.payments (user_id, payment_date);

alter table public.payment_accounts enable row level security;
alter table public.payments enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['payment_accounts', 'payments'] loop
    execute format('create policy "payments read" on public.%I for select using (public.can_access(user_id, ''reports'', ''view''))', t);
    execute format('create policy "payments write" on public.%I for all using (public.can_access(user_id, ''reports'', ''edit'')) with check (public.can_access(user_id, ''reports'', ''edit''))', t);
    if to_regprocedure('public.mfa_satisfied()') is not null then
      execute format(
        'create policy "two-step sign-in" on public.%I as restrictive for all to authenticated
           using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))', t);
    end if;
  end loop;
end $$;

-- Accounts are created and synced by the server; browsers can read them (not the key), rename, reassign or remove them.
revoke all on public.payment_accounts from anon, authenticated;
grant select (id, user_id, business_id, provider, name, livemode, status, last_error, last_synced_at, synced_through, backfill_cursor, created_at)
  on public.payment_accounts to authenticated;
grant update (business_id, name) on public.payment_accounts to authenticated;
grant delete on public.payment_accounts to authenticated;
-- Payments come only from the processor.
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

create or replace function public.check_payment_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'payments' then
    if not exists (select 1 from public.payment_accounts a where a.id = new.account_id and a.user_id = new.user_id) then
      raise exception 'That payment account belongs to another account';
    end if;
  elsif new.business_id is not null and not exists (
    select 1 from public.businesses b where b.id = new.business_id and b.user_id = new.user_id
  ) then
    raise exception 'That business belongs to another account';
  end if;
  return new;
end $$;
create trigger payment_accounts_owner before insert or update on public.payment_accounts
  for each row execute function public.check_payment_owner();
create trigger payments_owner before insert or update on public.payments
  for each row execute function public.check_payment_owner();

create or replace function public.payment_secret_set(p_account uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  select secret_id into v_secret from public.payment_accounts where id = p_account for update;
  if not found then raise exception 'No such payment account'; end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_secret, 'payment_account:' || p_account, 'Payment processor API key');
    update public.payment_accounts set secret_id = v_secret where id = p_account;
  else
    perform vault.update_secret(v_secret, p_secret);
  end if;
end $$;

create or replace function public.payment_secret_get(p_account uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.payment_accounts a join vault.decrypted_secrets s on s.id = a.secret_id
  where a.id = p_account
$$;

create or replace function public.payment_account_forget_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end $$;
create trigger payment_accounts_forget_secret after delete on public.payment_accounts
  for each row execute function public.payment_account_forget_secret();

revoke all on function public.check_payment_owner() from public, anon, authenticated;
revoke all on function public.payment_secret_set(uuid, text) from public, anon, authenticated;
revoke all on function public.payment_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.payment_account_forget_secret() from public, anon, authenticated;
grant execute on function public.payment_secret_set(uuid, text) to service_role;
grant execute on function public.payment_secret_get(uuid) to service_role;
