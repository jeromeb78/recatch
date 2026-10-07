-- Line items with landed cost: order-level tax, shipping and discounts spread across items by value.
create view public.inventory_lines with (security_invoker = true) as
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
  r.purchase_date, r.merchant, r.order_number, r.currency, r.status
from li
join public.receipts r on r.id = li.receipt_id
left join public.categories lc on lc.id = li.category_id
left join public.categories rc on rc.id = r.category_id
where r.document_type <> 'refund';
grant select on public.inventory_lines to authenticated;

-- Export view gains the new columns (appended, so no drop is needed).
create or replace view public.line_items_export with (security_invoker = true) as
select
  li.id as line_item_id, r.id as receipt_id, r.user_id, r.purchase_date, r.merchant, r.order_number,
  li.position, li.description, li.store_sku, li.woo_sku, li.quantity, li.unit_price, li.total,
  coalesce(lc.name, rc.name) as category,
  coalesce(lc.is_business, rc.is_business, false) as is_business,
  r.currency, r.status,
  li.pack_size, li.tax_line, li.use_type, li.tax_confidence
from public.line_items li
join public.receipts r on r.id = li.receipt_id
left join public.categories lc on lc.id = li.category_id
left join public.categories rc on rc.id = r.category_id;
