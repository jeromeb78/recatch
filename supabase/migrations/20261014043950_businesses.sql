-- Several businesses in one account. A receipt belongs to a business (or none = personal); single items can be
-- allocated to a different business than their receipt. Each sole proprietorship files its own Schedule C, so
-- write-offs, mileage and exports are worked out per business.

create table public.businesses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 80),
  entity_type     text not null default 'sole_prop'
                  check (entity_type in ('sole_prop', 'single_llc', 'partnership', 's_corp', 'c_corp', 'other')),
  ein             text check (ein is null or ein ~ '^[0-9]{2}-?[0-9]{7}$'),
  description     text,
  color           text,
  -- Auto-assignment: card last-4s ("4242") and store names ("Costco") that mean "this business".
  match_cards     text[] not null default '{}',
  match_merchants text[] not null default '{}',
  -- Same shape as profiles.tax_profile (home office, inventory counts, store miles, scenario…), per business.
  tax_profile     jsonb not null default '{}',
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, name)
);
create index businesses_user_idx on public.businesses (user_id);
alter table public.businesses enable row level security;

create policy "businesses read" on public.businesses for select using (
  public.can_access(user_id, 'receipts', 'view') or public.can_access(user_id, 'reports', 'view')
  or public.can_access(user_id, 'settings', 'view')
);
create policy "businesses add" on public.businesses for insert with check (public.can_access(user_id, 'settings', 'edit'));
create policy "businesses delete" on public.businesses for delete using (public.can_access(user_id, 'settings', 'edit'));
-- Report editors save each business's write-off answers (tax_profile); the guard below keeps them to that.
create policy "businesses update" on public.businesses for update
  using (public.can_access(user_id, 'settings', 'edit') or public.can_access(user_id, 'reports', 'edit'))
  with check (public.can_access(user_id, 'settings', 'edit') or public.can_access(user_id, 'reports', 'edit'));

-- Same two-step sign-in rule as every other table, when the security migration is already in place.
do $$
begin
  if to_regprocedure('public.mfa_satisfied()') is not null then
    create policy "two-step sign-in" on public.businesses as restrictive for all to authenticated
      using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));
  end if;
end $$;

create or replace function public.guard_business_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then raise exception 'A business can''t move to another account'; end if;
  if (select auth.uid()) is null or public.can_access(new.user_id, 'settings', 'edit') then return new; end if;
  if (to_jsonb(new) - 'tax_profile') is distinct from (to_jsonb(old) - 'tax_profile') then
    raise exception 'You don''t have permission to change business settings';
  end if;
  return new;
end $$;
create trigger businesses_guard before update on public.businesses
  for each row execute function public.guard_business_update();

alter table public.receipts   add column if not exists business_id uuid references public.businesses (id) on delete set null;
alter table public.line_items add column if not exists business_id uuid references public.businesses (id) on delete set null;
alter table public.trips      add column if not exists business_id uuid references public.businesses (id) on delete set null;
create index if not exists receipts_business_idx on public.receipts (business_id) where business_id is not null;
create index if not exists line_items_business_idx on public.line_items (business_id) where business_id is not null;

-- A row can only point at a business of the same account.
create or replace function public.check_business_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.business_id is not null and not exists (
    select 1 from public.businesses b where b.id = new.business_id and b.user_id = new.user_id
  ) then
    raise exception 'That business belongs to another account';
  end if;
  return new;
end $$;

/** The business a new receipt's card or store points to, if any rule matches (cards win over stores). */
create or replace function public.business_for(p_owner uuid, p_payment text, p_merchant text) returns uuid
language sql stable security definer set search_path = '' as $$
  select b.id from public.businesses b
  where b.user_id = p_owner and b.archived_at is null and (
    exists (select 1 from unnest(b.match_cards) c where length(c) >= 4 and coalesce(p_payment, '') like '%' || c || '%')
    or exists (select 1 from unnest(b.match_merchants) m
               where length(trim(m)) > 1 and lower(coalesce(p_merchant, '')) like lower(trim(m)) || '%')
  )
  order by exists (select 1 from unnest(b.match_cards) c where length(c) >= 4 and coalesce(p_payment, '') like '%' || c || '%') desc,
           b.created_at
  limit 1
$$;

create or replace function public.assign_receipt_business() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.business_id is null then
    new.business_id := public.business_for(new.user_id, new.payment_method, new.merchant);
  end if;
  return new;
end $$;

create trigger receipts_assign_business before insert on public.receipts
  for each row execute function public.assign_receipt_business();
create trigger receipts_business_owner before insert or update of business_id on public.receipts
  for each row execute function public.check_business_owner();
create trigger line_items_business_owner before insert or update of business_id on public.line_items
  for each row execute function public.check_business_owner();
create trigger trips_business_owner before insert or update of business_id on public.trips
  for each row execute function public.check_business_owner();

/** Applies the card/store rules to receipts that have no business yet (needs receipts edit). Returns the count. */
create or replace function public.apply_business_rules(p_owner uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if not public.can_access(p_owner, 'receipts', 'edit') then
    raise exception 'You don''t have permission to change receipts in this account';
  end if;
  update public.receipts r set business_id = public.business_for(r.user_id, r.payment_method, r.merchant)
  where r.user_id = p_owner and r.business_id is null
    and public.business_for(r.user_id, r.payment_method, r.merchant) is not null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.guard_business_update() from public, anon, authenticated;
revoke all on function public.check_business_owner() from public, anon, authenticated;
revoke all on function public.assign_receipt_business() from public, anon, authenticated;
revoke all on function public.business_for(uuid, text, text) from public, anon, authenticated;
revoke all on function public.apply_business_rules(uuid) from public, anon;
grant execute on function public.apply_business_rules(uuid) to authenticated;

-- inventory_lines gains the item's business (its own, else its receipt's), appended so no drop is needed.
create or replace view public.inventory_lines with (security_invoker = true) as
with li as (
  select l.*, sum(l.total) over (partition by l.receipt_id) as items_sum
  from public.line_items l
)
select
  li.id, li.user_id, li.receipt_id, li.description, li.store_sku, li.woo_sku, li.quantity, li.pack_size,
  (li.quantity * li.pack_size)::numeric(14, 3) as units,
  li.total as item_total,
  case
    when r.total is not null and li.items_sum > 0 and li.total is not null
      then round(li.total * r.total / li.items_sum, 2)
    else li.total
  end as landed_total,
  li.tax_line, li.use_type,
  coalesce(lc.name, rc.name) as category,
  coalesce(lc.is_business, rc.is_business, false) as is_business,
  r.purchase_date, r.merchant, r.order_number, r.currency, r.status,
  li.tax_confidence, li.business_pct, li.unit_price,
  coalesce(li.business_id, r.business_id) as business_id
from li
join public.receipts r on r.id = li.receipt_id
left join public.categories lc on lc.id = li.category_id
left join public.categories rc on rc.id = r.category_id
where r.document_type <> 'refund';
