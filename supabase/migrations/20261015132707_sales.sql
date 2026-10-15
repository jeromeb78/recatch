-- Sales: where a business sells (a WooCommerce store, or files imported from eBay, Etsy, Shopify…), the orders and
-- the items sold. Together with receipts this gives profit & loss, profit per product and inventory on hand.
-- Customer names and addresses are never stored. Sales belong to the "reports" area for team access.

create table public.sales_channels (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  business_id    uuid references public.businesses (id) on delete set null,
  kind           text not null check (kind in ('woocommerce', 'csv')),
  name           text not null check (length(trim(name)) between 1 and 80),
  store_url      text check (store_url is null or store_url ~ '^https://'),
  -- Woo API key pair, encrypted in Vault (service role only).
  secret_id      uuid,
  status         text not null default 'active' check (status in ('active', 'error')),
  last_error     text,
  last_synced_at timestamptz,
  synced_through timestamptz,
  created_at     timestamptz not null default now()
);
create index sales_channels_user_idx on public.sales_channels (user_id);

create table public.sales_orders (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  channel_id       uuid not null references public.sales_channels (id) on delete cascade,
  business_id      uuid references public.businesses (id) on delete set null,
  external_id      text not null,
  order_number     text,
  order_date       date not null,
  -- paid = counts as a sale; refunded/cancelled/pending are kept but left out of sales.
  status           text not null default 'paid' check (status in ('paid', 'refunded', 'cancelled', 'pending')),
  currency         text not null default 'USD',
  items_total      numeric(12, 2) not null default 0, -- items after discounts
  discount         numeric(12, 2) not null default 0,
  shipping_charged numeric(12, 2) not null default 0, -- shipping the customer paid (income)
  tax_collected    numeric(12, 2) not null default 0, -- sales tax collected (not income)
  refunded         numeric(12, 2) not null default 0,
  fees             numeric(12, 2) not null default 0, -- payment / platform fees
  total            numeric(12, 2) not null default 0, -- what the customer paid
  updated_at       timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index sales_orders_user_date_idx on public.sales_orders (user_id, order_date);

create table public.sales_lines (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  order_id   uuid not null references public.sales_orders (id) on delete cascade,
  sku        text,
  name       text not null,
  quantity   numeric(12, 3) not null default 1,
  total      numeric(12, 2) not null default 0 -- after discounts
);
create index sales_lines_order_idx on public.sales_lines (order_id);
create index sales_lines_user_sku_idx on public.sales_lines (user_id, sku);

-- The store's product catalog (SKU + name), for matching purchases to what's sold.
create table public.sales_products (
  user_id     uuid not null references auth.users (id) on delete cascade,
  channel_id  uuid not null references public.sales_channels (id) on delete cascade,
  external_id text not null,
  sku         text not null,
  name        text not null,
  price       numeric(12, 2),
  stock       numeric(12, 3),
  primary key (channel_id, external_id)
);
create index sales_products_user_idx on public.sales_products (user_id);

alter table public.sales_channels enable row level security;
alter table public.sales_orders   enable row level security;
alter table public.sales_lines    enable row level security;
alter table public.sales_products enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['sales_channels', 'sales_orders', 'sales_lines', 'sales_products'] loop
    execute format('create policy "sales read" on public.%I for select using (public.can_access(user_id, ''reports'', ''view''))', t);
    execute format('create policy "sales write" on public.%I for all using (public.can_access(user_id, ''reports'', ''edit'')) with check (public.can_access(user_id, ''reports'', ''edit''))', t);
    if to_regprocedure('public.mfa_satisfied()') is not null then
      execute format(
        'create policy "two-step sign-in" on public.%I as restrictive for all to authenticated
           using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))', t);
    end if;
  end loop;
end $$;

-- The Vault reference is server-only; browsers see everything else about a channel.
revoke all on public.sales_channels from anon, authenticated;
grant select (id, user_id, business_id, kind, name, store_url, status, last_error, last_synced_at, synced_through, created_at)
  on public.sales_channels to authenticated;
grant insert (user_id, business_id, kind, name) on public.sales_channels to authenticated;
grant update (business_id, name) on public.sales_channels to authenticated;
grant delete on public.sales_channels to authenticated;
revoke all on public.sales_orders, public.sales_lines, public.sales_products from anon;

-- Rows must stay within one account: an order's channel, a line's order, a channel's business.
create or replace function public.check_sales_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Each table's fields are only touched in its own branch (PL/pgSQL resolves new.x eagerly).
  if tg_table_name in ('sales_orders', 'sales_products') then
    if not exists (select 1 from public.sales_channels c where c.id = new.channel_id and c.user_id = new.user_id) then
      raise exception 'That sales channel belongs to another account';
    end if;
  elsif tg_table_name = 'sales_lines' then
    if not exists (select 1 from public.sales_orders o where o.id = new.order_id and o.user_id = new.user_id) then
      raise exception 'That order belongs to another account';
    end if;
  end if;
  if tg_table_name in ('sales_channels', 'sales_orders') then
    if new.business_id is not null and not exists (
      select 1 from public.businesses b where b.id = new.business_id and b.user_id = new.user_id
    ) then raise exception 'That business belongs to another account'; end if;
  end if;
  return new;
end $$;
create trigger sales_channels_owner before insert or update on public.sales_channels
  for each row execute function public.check_sales_owner();
create trigger sales_orders_owner before insert or update on public.sales_orders
  for each row execute function public.check_sales_owner();
create trigger sales_lines_owner before insert or update on public.sales_lines
  for each row execute function public.check_sales_owner();
create trigger sales_products_owner before insert or update on public.sales_products
  for each row execute function public.check_sales_owner();

-- Moving a channel to another business moves its orders too.
create or replace function public.sales_channel_business() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id then
    update public.sales_orders set business_id = new.business_id where channel_id = new.id;
  end if;
  return new;
end $$;
create trigger sales_channels_business after update of business_id on public.sales_channels
  for each row execute function public.sales_channel_business();

-- Woo API keys live in Vault. Service role only.
create or replace function public.sales_secret_set(p_channel uuid, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  select secret_id into v_secret from public.sales_channels where id = p_channel for update;
  if not found then raise exception 'No such channel'; end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_secret, 'sales_channel:' || p_channel, 'Store API key');
    update public.sales_channels set secret_id = v_secret where id = p_channel;
  else
    perform vault.update_secret(v_secret, p_secret);
  end if;
end $$;

create or replace function public.sales_secret_get(p_channel uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.sales_channels c join vault.decrypted_secrets s on s.id = c.secret_id
  where c.id = p_channel
$$;

create or replace function public.sales_channel_forget_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end $$;
create trigger sales_channels_forget_secret after delete on public.sales_channels
  for each row execute function public.sales_channel_forget_secret();

revoke all on function public.check_sales_owner() from public, anon, authenticated;
revoke all on function public.sales_channel_business() from public, anon, authenticated;
revoke all on function public.sales_secret_set(uuid, text) from public, anon, authenticated;
revoke all on function public.sales_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.sales_channel_forget_secret() from public, anon, authenticated;
grant execute on function public.sales_secret_set(uuid, text) to service_role;
grant execute on function public.sales_secret_get(uuid) to service_role;
