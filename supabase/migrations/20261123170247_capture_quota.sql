-- 1. Daily cap on receipt captures that call Claude (forwarding address, browser extension, phone Shortcut, uploads,
--    Claude connector). Stops someone who learns a forwarding address or connection code from running up API costs
--    or flooding an account. Gmail sync is already bounded per run and isn't counted.
-- 2. Close the Supabase advisor finding on public.rls_auto_enable() (an event-trigger function created outside these
--    migrations): nobody should call it over the API. Revoking EXECUTE doesn't stop the event trigger from firing.

/* ---------- 1. capture quota ---------- */

create table if not exists public.capture_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  source     text not null,
  created_at timestamptz not null default now()
);
create index if not exists capture_log_user_time on public.capture_log (user_id, created_at);

alter table public.capture_log enable row level security;
revoke all on public.capture_log from anon, authenticated;

/**
 * Records one capture for p_user and returns true, unless p_user already has p_limit captures in the last 24 hours
 * (then records nothing and returns false). Service role only.
 */
create or replace function public.take_capture_quota(p_user uuid, p_source text, p_limit int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_used int;
begin
  -- One caller at a time per account, so parallel requests can't all slip under the limit.
  perform pg_advisory_xact_lock(hashtextextended('capture_quota:' || p_user::text, 0));
  delete from public.capture_log where user_id = p_user and created_at < now() - interval '2 days';
  select count(*) into v_used from public.capture_log
    where user_id = p_user and created_at > now() - interval '24 hours';
  if v_used >= p_limit then
    return false;
  end if;
  insert into public.capture_log (user_id, source) values (p_user, left(p_source, 20));
  return true;
end $$;

revoke all on function public.take_capture_quota(uuid, text, int) from public, anon, authenticated;
grant execute on function public.take_capture_quota(uuid, text, int) to service_role;

/* ---------- 2. rls_auto_enable ---------- */

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;
