-- Connection codes for the browser extension. Only a SHA-256 hash of the token is stored.
create table public.api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'Browser extension',
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
alter table public.api_tokens enable row level security;
create policy "own tokens" on public.api_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.api_tokens from anon;
