-- Extension source, tax categorization columns, pack size, editable profile settings.

-- Receipts can now come from the browser extension.
alter table public.receipts drop constraint if exists receipts_source_check;
alter table public.receipts add constraint receipts_source_check
  check (source in ('gmail', 'forward', 'upload', 'extension'));
alter table public.receipts add column if not exists source_url text;

-- Tax categorization + pack size on line items.
alter table public.line_items
  add column if not exists tax_line text,
  add column if not exists use_type text check (use_type in ('business', 'personal', 'mixed')),
  add column if not exists tax_confidence numeric(3, 2),
  add column if not exists pack_size integer not null default 1 check (pack_size > 0);

create index if not exists line_items_woo_sku_idx on public.line_items (user_id, woo_sku) where woo_sku is not null;
create index if not exists line_items_uncategorized_idx on public.line_items (user_id) where tax_line is null;

-- Profile settings the user may edit: business context for Claude, accounting export mapping.
alter table public.profiles
  add column if not exists business_description text,
  add column if not exists export_settings jsonb not null default '{}',
  add column if not exists onboarded_at timestamptz;

grant update (business_description, export_settings, onboarded_at) on public.profiles to authenticated;
create policy "own profile update" on public.profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
