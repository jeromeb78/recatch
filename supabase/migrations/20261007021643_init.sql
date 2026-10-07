-- Receipt Catcher: schema, RLS, storage and views.

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user) — holds the forwarding-address token.
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  email         text,
  inbound_token text not null unique default substr(md5(gen_random_uuid()::text), 1, 18),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Categories. is_business rolls up into the dashboard's Business total.
-- ---------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  is_business boolean not null default false,
  color       text,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------------------------------------------------------------------------
-- Gmail connections. refresh_token is hidden from browser clients (see grants).
-- ---------------------------------------------------------------------------
create table public.email_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null default 'gmail' check (provider in ('gmail')),
  email          text not null,
  refresh_token  text not null,
  status         text not null default 'active' check (status in ('active', 'error', 'revoked')),
  last_error     text,
  sync_from      timestamptz not null default (now() - interval '30 days'),
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (user_id, provider, email)
);

-- ---------------------------------------------------------------------------
-- Receipts + line items.
-- ---------------------------------------------------------------------------
create table public.receipts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  source            text not null check (source in ('gmail', 'forward', 'upload')),
  source_message_id text,
  connection_id     uuid references public.email_connections (id) on delete set null,
  status            text not null default 'ready' check (status in ('ready', 'needs_review')),
  review_reasons    text[] not null default '{}',
  document_type     text not null default 'receipt',
  merchant          text,
  merchant_key      text generated always as (nullif(lower(regexp_replace(coalesce(merchant, ''), '[^a-zA-Z0-9]', '', 'g')), '')) stored,
  order_number      text,
  purchase_date     date,
  currency          text not null default 'USD',
  subtotal          numeric(12, 2),
  tax               numeric(12, 2),
  shipping          numeric(12, 2),
  discount          numeric(12, 2),
  total             numeric(12, 2),
  payment_method    text,
  category_id       uuid references public.categories (id) on delete set null,
  notes             text,
  confidence        numeric(3, 2),
  email_subject     text,
  email_from        text,
  files             jsonb not null default '[]',   -- [{path, mime, name}]
  items_text        text not null default '',      -- denormalized line-item descriptions for search
  extracted         jsonb,                         -- raw model output
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index receipts_user_message_uniq
  on public.receipts (user_id, source_message_id) where source_message_id is not null;
create unique index receipts_user_order_uniq
  on public.receipts (user_id, merchant_key, order_number, document_type)
  where order_number is not null and merchant_key is not null;
create index receipts_user_date_idx on public.receipts (user_id, purchase_date desc);

create table public.line_items (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references public.receipts (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  position    int not null default 0,
  description text not null,
  store_sku   text,
  quantity    numeric(12, 3) not null default 1,
  unit_price  numeric(12, 2),
  total       numeric(12, 2),
  category_id uuid references public.categories (id) on delete set null,
  woo_sku     text,
  created_at  timestamptz not null default now()
);

create index line_items_receipt_idx on public.line_items (receipt_id, position);
create index line_items_user_idx on public.line_items (user_id);

-- Every Gmail message we've looked at, so non-receipts aren't re-sent to Claude.
create table public.processed_messages (
  user_id       uuid not null references auth.users (id) on delete cascade,
  connection_id uuid references public.email_connections (id) on delete cascade,
  message_id    text not null,
  outcome       text not null check (outcome in ('receipt', 'duplicate', 'skipped', 'error')),
  receipt_id    uuid references public.receipts (id) on delete set null,
  detail        text,
  processed_at  timestamptz not null default now(),
  primary key (user_id, message_id)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger receipts_touch before update on public.receipts
  for each row execute function public.touch_updated_at();

create or replace function public.refresh_items_text() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rid uuid := coalesce(new.receipt_id, old.receipt_id);
begin
  update public.receipts r
     set items_text = coalesce((
           select string_agg(li.description || coalesce(' ' || li.store_sku, '') || coalesce(' ' || li.woo_sku, ''), ' | ' order by li.position)
             from public.line_items li where li.receipt_id = rid), '')
   where r.id = rid;
  return null;
end $$;

create trigger line_items_items_text
  after insert or update or delete on public.line_items
  for each row execute function public.refresh_items_text();

-- New user → profile + starter categories.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email) values (new.id, new.email)
    on conflict (user_id) do nothing;
  insert into public.categories (user_id, name, is_business, color) values
    (new.id, 'Inventory (COGS)',  true,  '#2563eb'),
    (new.id, 'Shipping Supplies', true,  '#7c3aed'),
    (new.id, 'Office & Software', true,  '#0891b2'),
    (new.id, 'Groceries',         false, '#16a34a'),
    (new.id, 'Household',         false, '#ca8a04'),
    (new.id, 'Personal',          false, '#db2777'),
    (new.id, 'Other',             false, '#6b7280')
  on conflict (user_id, name) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.categories         enable row level security;
alter table public.email_connections  enable row level security;
alter table public.receipts           enable row level security;
alter table public.line_items         enable row level security;
alter table public.processed_messages enable row level security;

create policy "own profile" on public.profiles
  for select using (user_id = auth.uid());

create policy "own categories" on public.categories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own connections read" on public.email_connections
  for select using (user_id = auth.uid());
create policy "own connections delete" on public.email_connections
  for delete using (user_id = auth.uid());

create policy "own receipts" on public.receipts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own line items" on public.line_items
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.receipts r where r.id = receipt_id and r.user_id = auth.uid())
  );

create policy "own processed messages" on public.processed_messages
  for select using (user_id = auth.uid());

-- Browser clients never see refresh tokens: column-level grants only.
revoke all on public.email_connections from anon, authenticated;
grant select (id, user_id, provider, email, status, last_error, sync_from, last_synced_at, created_at)
  on public.email_connections to authenticated;
grant delete on public.email_connections to authenticated;

-- Profiles are written by the trigger only; the token can't be changed from the browser.
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.processed_messages from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Views (security_invoker so RLS applies to the caller)
-- ---------------------------------------------------------------------------
create view public.monthly_totals with (security_invoker = true) as
select
  r.user_id,
  date_trunc('month', r.purchase_date)::date as month,
  count(*)                                           as receipts,
  sum(r.total)                                       as total,
  sum(r.total) filter (where c.is_business)          as business_total,
  sum(r.total) filter (where not coalesce(c.is_business, false)) as personal_total
from public.receipts r
left join public.categories c on c.id = r.category_id
where r.document_type <> 'refund'
group by r.user_id, date_trunc('month', r.purchase_date);

create view public.line_items_export with (security_invoker = true) as
select
  li.id                 as line_item_id,
  r.id                  as receipt_id,
  r.user_id,
  r.purchase_date,
  r.merchant,
  r.order_number,
  li.position,
  li.description,
  li.store_sku,
  li.woo_sku,
  li.quantity,
  li.unit_price,
  li.total,
  coalesce(lc.name, rc.name)                         as category,
  coalesce(lc.is_business, rc.is_business, false)    as is_business,
  r.currency,
  r.status
from public.line_items li
join public.receipts r on r.id = li.receipt_id
left join public.categories lc on lc.id = li.category_id
left join public.categories rc on rc.id = r.category_id;

grant select on public.monthly_totals, public.line_items_export to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, objects under {user_id}/...
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('receipts', 'receipts', false, 26214400)
on conflict (id) do nothing;

create policy "receipts read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "receipts upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "receipts delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
