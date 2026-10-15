-- Shipping: label costs from a shipping platform (Easyship), matched to store orders by the order number the label was
-- bought for. Against Stripe-confirmed orders this shows what each order's shipping really cost versus what the customer
-- paid for it. Addresses, names and contact details on shipments are never stored.

create table public.shipping_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  business_id     uuid references public.businesses (id) on delete set null,
  provider        text not null default 'easyship' check (provider in ('easyship')),
  name            text not null check (length(trim(name)) between 1 and 80),
  -- API access token, encrypted in Vault (service role only).
  secret_id       uuid,
  status          text not null default 'active' check (status in ('active', 'error')),
  last_error      text,
  last_synced_at  timestamptz,
  synced_through  timestamptz, -- incremental syncs read shipments updated since this time
  backfill_cursor text,        -- history import position (a page number); 'done' once all history is in
  created_at      timestamptz not null default now()
);
create index shipping_accounts_user_idx on public.shipping_accounts (user_id);

create table public.shipments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  account_id    uuid not null references public.shipping_accounts (id) on delete cascade,
  external_id   text not null,  -- Easyship shipment id (ES…)
  order_ref     text,           -- the store's order number the label was bought for
  platform_name text,
  ship_date     date not null,  -- when the label was paid for (else created)
  state         text not null default 'active' check (state in ('active', 'cancelled')),
  label_state   text,
  courier       text,
  tracking      text,
  destination_country text,
  currency      text not null default 'USD',
  label_cost    numeric(12, 2) not null default 0, -- total charged for the label incl. surcharges and insurance
  updated_at    timestamptz not null default now(),
  unique (account_id, external_id)
);
create index shipments_user_date_idx on public.shipments (user_id, ship_date);
create index shipments_user_order_idx on public.shipments (user_id, order_ref);

alter table public.shipping_accounts enable row level security;
alter table public.shipments enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['shipping_accounts', 'shipments'] loop
    execute format('create policy "shipping read" on public.%I for select using (public.can_access(user_id, ''reports'', ''view''))', t);
    execute format('create policy "shipping write" on public.%I for all using (public.can_access(user_id, ''reports'', ''edit'')) with check (public.can_access(user_id, ''reports'', ''edit''))', t);
    if to_regprocedure('public.mfa_satisfied()') is not null then
      execute format(
        'create policy "two-step sign-in" on public.%I as restrictive for all to authenticated
           using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))', t);
    end if;
  end loop;
end $$;

revoke all on public.shipping_accounts from anon, authenticated;
grant select (id, user_id, business_id, provider, name, status, last_error, last_synced_at, synced_through, backfill_cursor, created_at)
  on public.shipping_accounts to authenticated;
grant update (business_id, name) on public.shipping_accounts to authenticated;
grant delete on public.shipping_accounts to authenticated;
revoke all on public.shipments from anon, authenticated;
grant select on public.shipments to authenticated;

create or replace function public.check_shipping_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'shipments' then
    if not exists (select 1 from public.shipping_accounts a where a.id = new.account_id and a.user_id = new.user_id) then
      raise exception 'That shipping account belongs to another account';
    end if;
  elsif new.business_id is not null and not exists (
    select 1 from public.businesses b where b.id = new.business_id and b.user_id = new.user_id
  ) then
    raise exception 'That business belongs to another account';
  end if;
  return new;
end $$;
create trigger shipping_accounts_owner before insert or update on public.shipping_accounts
  for each row execute function public.check_shipping_owner();
create trigger shipments_owner before insert or update on public.shipments
  for each row execute function public.check_shipping_owner();

create or replace function public.shipping_secret_set(p_account uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  select secret_id into v_secret from public.shipping_accounts where id = p_account for update;
  if not found then raise exception 'No such shipping account'; end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_secret, 'shipping_account:' || p_account, 'Shipping platform API token');
    update public.shipping_accounts set secret_id = v_secret where id = p_account;
  else
    perform vault.update_secret(v_secret, p_secret);
  end if;
end $$;

create or replace function public.shipping_secret_get(p_account uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.shipping_accounts a join vault.decrypted_secrets s on s.id = a.secret_id
  where a.id = p_account
$$;

create or replace function public.shipping_account_forget_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end $$;
create trigger shipping_accounts_forget_secret after delete on public.shipping_accounts
  for each row execute function public.shipping_account_forget_secret();

revoke all on function public.check_shipping_owner() from public, anon, authenticated;
revoke all on function public.shipping_secret_set(uuid, text) from public, anon, authenticated;
revoke all on function public.shipping_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.shipping_account_forget_secret() from public, anon, authenticated;
grant execute on function public.shipping_secret_set(uuid, text) to service_role;
grant execute on function public.shipping_secret_get(uuid) to service_role;
