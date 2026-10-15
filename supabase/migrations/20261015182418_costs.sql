-- Cost of goods for resellers whose receipts don't name the exact item ("Hot Wheels single pack – styles may vary").
-- A product's unit cost resolves, most specific first:
--   1. sku_costs.unit_cost      — the owner's own cost for that SKU (typed or uploaded)
--   2. sales_products.cost      — a cost kept in the store (WooCommerce cost-of-goods field or plugin)
--   3. receipts tagged with the SKU (line_items.woo_sku), average landed cost
--   4. a cost pool (product line): sku_costs.pool_id if pinned, else the first pool whose product words match the name;
--      the pool's unit_cost if set, else the average landed cost of receipts whose description matches its purchase words.

alter table public.sales_products add column if not exists cost numeric(12, 4);

create table public.cost_pools (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  business_id    uuid references public.businesses (id) on delete set null,
  name           text not null check (length(trim(name)) between 1 and 80),
  -- Each entry is a phrase; a name matches when it contains every word of any one phrase.
  purchase_words text[] not null default '{}',
  product_words  text[] not null default '{}',
  unit_cost      numeric(12, 4) check (unit_cost is null or unit_cost >= 0),
  position       integer not null default 0, -- lower first; the first matching pool wins
  created_at     timestamptz not null default now()
);
create index cost_pools_user_idx on public.cost_pools (user_id, position);

create table public.sku_costs (
  user_id    uuid not null references auth.users (id) on delete cascade,
  sku        text not null check (sku = upper(trim(sku)) and length(sku) between 1 and 100),
  unit_cost  numeric(12, 4) check (unit_cost is null or unit_cost >= 0),
  pool_id    uuid references public.cost_pools (id) on delete set null,
  note       text check (note is null or length(note) <= 200),
  updated_at timestamptz not null default now(),
  primary key (user_id, sku)
);

alter table public.cost_pools enable row level security;
alter table public.sku_costs enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['cost_pools', 'sku_costs'] loop
    execute format('create policy "costs read" on public.%I for select using (public.can_access(user_id, ''reports'', ''view''))', t);
    execute format('create policy "costs write" on public.%I for all using (public.can_access(user_id, ''reports'', ''edit'')) with check (public.can_access(user_id, ''reports'', ''edit''))', t);
    if to_regprocedure('public.mfa_satisfied()') is not null then
      execute format(
        'create policy "two-step sign-in" on public.%I as restrictive for all to authenticated
           using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))', t);
    end if;
  end loop;
end $$;

revoke all on public.cost_pools, public.sku_costs from anon;

create or replace function public.check_cost_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'cost_pools' then
    if new.business_id is not null and not exists (
      select 1 from public.businesses b where b.id = new.business_id and b.user_id = new.user_id
    ) then raise exception 'That business belongs to another account'; end if;
  elsif new.pool_id is not null and not exists (
    select 1 from public.cost_pools p where p.id = new.pool_id and p.user_id = new.user_id
  ) then
    raise exception 'That product line belongs to another account';
  end if;
  return new;
end $$;
create trigger cost_pools_owner before insert or update on public.cost_pools
  for each row execute function public.check_cost_owner();
create trigger sku_costs_owner before insert or update on public.sku_costs
  for each row execute function public.check_cost_owner();
revoke all on function public.check_cost_owner() from public, anon, authenticated;
