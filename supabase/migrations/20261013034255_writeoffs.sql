-- Write-off finder: business-use % on mixed items, a mileage log, and per-year tax inputs.

-- Share of a mixed-use item that is business (null = not set yet).
alter table public.line_items
  add column if not exists business_pct smallint check (business_pct between 0 and 100);

-- Mileage log. A trip may come from store receipts (receipt_ids) or be entered by hand.
create table if not exists public.trips (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  trip_date    date not null,
  destination  text not null,
  purpose      text not null default 'Buying inventory and supplies',
  miles        numeric(8, 1) not null check (miles > 0 and miles < 10000),
  merchant_key text,
  receipt_ids  uuid[] not null default '{}',
  created_at   timestamptz not null default now()
);
create index if not exists trips_user_date_idx on public.trips (user_id, trip_date);
-- One logged trip per store per day, so adding suggested trips twice is harmless.
create unique index if not exists trips_store_day_idx on public.trips (user_id, trip_date, merchant_key)
  where merchant_key is not null;

alter table public.trips enable row level security;
create policy "own trips" on public.trips
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.trips to authenticated;

-- Store distances, home office, phone/internet, fees, inventory counts and chosen scenario, by year.
alter table public.profiles add column if not exists tax_profile jsonb not null default '{}';
grant update (tax_profile) on public.profiles to authenticated;

-- inventory_lines gains the columns the write-off finder needs (appended, so no drop is needed).
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
  li.tax_confidence, li.business_pct, li.unit_price
from li
join public.receipts r on r.id = li.receipt_id
left join public.categories lc on lc.id = li.category_id
left join public.categories rc on rc.id = r.category_id
where r.document_type <> 'refund';
