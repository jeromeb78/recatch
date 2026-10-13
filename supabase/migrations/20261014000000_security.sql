-- Security hardening:
--   1. Gmail refresh tokens move into Supabase Vault (encrypted with a key kept outside the database).
--   2. Two-step sign-in is enforced by the database: once someone turns on an authenticator app, their
--      data only opens from a session that passed the second step (aal2). Owners can also require it
--      of everyone on their team.

/* ---------- 1. Gmail tokens in Vault ---------- */

alter table public.email_connections add column if not exists token_secret_id uuid;
alter table public.email_connections alter column refresh_token drop not null; -- dropped below once moved

/** Stores (or replaces) a connection's Gmail refresh token in Vault. Service role only. */
create or replace function public.gmail_token_set(p_connection uuid, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_secret uuid;
begin
  select token_secret_id into v_secret from public.email_connections where id = p_connection for update;
  if not found then raise exception 'No such connection'; end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_token, 'gmail_refresh_token:' || p_connection, 'Gmail refresh token');
  else
    perform vault.update_secret(v_secret, p_token);
  end if;
  update public.email_connections set token_secret_id = v_secret where id = p_connection;
end $$;

/** A connection's Gmail refresh token, decrypted. Service role only. */
create or replace function public.gmail_token_get(p_connection uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from public.email_connections c
    join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.id = p_connection
$$;

-- Disconnecting Gmail (or deleting the account) removes the stored token too.
create or replace function public.email_connection_forget_token() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.token_secret_id is not null then
    delete from vault.secrets where id = old.token_secret_id;
  end if;
  return old;
end $$;
drop trigger if exists email_connections_forget_token on public.email_connections;
create trigger email_connections_forget_token after delete on public.email_connections
  for each row execute function public.email_connection_forget_token();

revoke all on function public.gmail_token_set(uuid, text) from public, anon, authenticated;
revoke all on function public.gmail_token_get(uuid) from public, anon, authenticated;
revoke all on function public.email_connection_forget_token() from public, anon, authenticated;
grant execute on function public.gmail_token_set(uuid, text) to service_role;
grant execute on function public.gmail_token_get(uuid) to service_role;

-- Move any tokens already saved, then drop the plain-text column.
do $$
declare
  r record;
begin
  for r in select id, refresh_token from public.email_connections where refresh_token is not null loop
    perform public.gmail_token_set(r.id, r.refresh_token);
  end loop;
end $$;
alter table public.email_connections drop column refresh_token;

/* ---------- 2. Two-step sign-in ---------- */

/** False only when the caller has an authenticator app set up but this session skipped the second step. */
create or replace function public.mfa_satisfied() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()->>'aal'), '') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified'
    )
$$;
revoke all on function public.mfa_satisfied() from public, anon;
grant execute on function public.mfa_satisfied() to authenticated;

alter table public.profiles add column if not exists require_team_mfa boolean not null default false;
grant update (require_team_mfa) on public.profiles to authenticated;

/** As before, plus: two-step sign-in when the caller has it, and for members when the owner requires it. */
create or replace function public.can_access(p_owner uuid, p_area text, p_level text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select public.mfa_satisfied() and (
    p_owner = (select auth.uid()) or exists (
      select 1 from public.account_members m join public.profiles p on p.user_id = m.owner_id
      where m.owner_id = p_owner and m.member_id = (select auth.uid())
        and case when p_level = 'edit' then m.permissions->>p_area = 'edit'
                 else m.permissions->>p_area in ('view', 'edit') end
        and (not p.require_team_mfa or coalesce((select auth.jwt()->>'aal'), '') = 'aal2')
    )
  )
$$;

/** Whether an account requires its team to use two-step sign-in (for the owner and its members). */
create or replace function public.team_requires_mfa(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select p.require_team_mfa from public.profiles p
    where p.user_id = p_owner and (
      p_owner = (select auth.uid())
      or exists (select 1 from public.account_members m where m.owner_id = p_owner and m.member_id = (select auth.uid()))
    )
  ), false)
$$;
revoke all on function public.team_requires_mfa(uuid) from public, anon;
grant execute on function public.team_requires_mfa(uuid) to authenticated;

-- Only the owner can switch the team requirement.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.user_id = (select auth.uid()) then
    return new; -- service role or the owner
  end if;
  if new.onboarded_at is distinct from old.onboarded_at or new.require_team_mfa is distinct from old.require_team_mfa then
    raise exception 'Only the account owner can change this';
  end if;
  if new.business_description is distinct from old.business_description and not public.can_access(new.user_id, 'settings', 'edit') then
    raise exception 'You don''t have permission to change business settings';
  end if;
  if (new.tax_profile is distinct from old.tax_profile or new.export_settings is distinct from old.export_settings)
     and not public.can_access(new.user_id, 'reports', 'edit') then
    raise exception 'You don''t have permission to change report settings';
  end if;
  return new;
end $$;

-- Restrictive policies are ANDed with every other policy, so a password alone never opens data
-- for someone who set up an authenticator app.
do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'categories', 'email_connections', 'receipts', 'line_items', 'trips',
                           'processed_messages', 'api_tokens', 'oauth_tokens', 'account_members', 'account_invites'] loop
    execute format('drop policy if exists "two-step sign-in" on public.%I', t);
    execute format(
      'create policy "two-step sign-in" on public.%I as restrictive for all to authenticated
         using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))', t);
  end loop;
end $$;
drop policy if exists "two-step sign-in" on storage.objects;
create policy "two-step sign-in" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'receipts' or (select public.mfa_satisfied()))
  with check (bucket_id <> 'receipts' or (select public.mfa_satisfied()));
