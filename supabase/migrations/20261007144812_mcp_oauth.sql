-- OAuth 2.1 for the Claude connector (MCP). Codes and tokens are stored as SHA-256 hashes only.

alter table public.receipts drop constraint if exists receipts_source_check;
alter table public.receipts add constraint receipts_source_check
  check (source in ('gmail', 'forward', 'upload', 'extension', 'claude'));

-- Apps registered via dynamic client registration (e.g. Claude).
create table public.oauth_clients (
  id            text primary key,
  client_name   text not null default 'MCP client',
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

create table public.oauth_codes (
  code_hash      text primary key,
  client_id      text not null references public.oauth_clients (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  scope          text,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

create table public.oauth_tokens (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  client_id          text not null references public.oauth_clients (id) on delete cascade,
  access_hash        text not null unique,
  refresh_hash       text unique,
  scope              text,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
create index oauth_tokens_user_idx on public.oauth_tokens (user_id) where revoked_at is null;

alter table public.oauth_clients enable row level security;
alter table public.oauth_codes   enable row level security;
alter table public.oauth_tokens  enable row level security;

-- Signed-in users can see app names (for "Connected apps") and list / revoke their own grants.
create policy "client names readable" on public.oauth_clients for select to authenticated using (true);
create policy "own grants" on public.oauth_tokens for select using (user_id = auth.uid());
create policy "revoke own grants" on public.oauth_tokens for update using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.oauth_codes from anon, authenticated;
revoke all on public.oauth_clients from anon;
revoke insert, update, delete on public.oauth_clients from authenticated;
revoke all on public.oauth_tokens from anon, authenticated;
grant select (id, user_id, client_id, scope, created_at, last_used_at, revoked_at) on public.oauth_tokens to authenticated;
grant update (revoked_at) on public.oauth_tokens to authenticated;
