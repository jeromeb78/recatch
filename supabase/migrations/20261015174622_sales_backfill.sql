-- WooCommerce sync progress: "<page>" while importing all orders by id, "inc:<page>:<pass start>" mid-update, "done" between.
-- (Replaces a modified-date cursor that could skip orders when a store ignores sorting by modified date.)
alter table public.sales_channels add column if not exists backfill_cursor text;
grant select (backfill_cursor) on public.sales_channels to authenticated;
