-- Team access: an account owner invites people and decides, per area, whether they can view or edit.
-- Data stays keyed by the owner's user_id; row-level security asks can_access(owner, area, level).
--   receipts → receipts, line items, receipt files          (none | view | edit)
--   reports  → write-offs, mileage, inventory, exports      (none | view | edit)
--   settings → business description, categories, forwarding (none | view | edit)
--   team     → invite/remove people, change access           (none | edit)
-- Gmail, the browser extension and the Claude connector stay with the owner.

create or replace function public.valid_permissions(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
    and coalesce(p->>'receipts', '') in ('none', 'view', 'edit')
    and coalesce(p->>'reports', '') in ('none', 'view', 'edit')
    and coalesce(p->>'settings', '') in ('none', 'view', 'edit')
    and coalesce(p->>'team', '') in ('none', 'edit')
$$;

create table public.account_members (
  owner_id     uuid not null references auth.users (id) on delete cascade,
  member_id    uuid not null references auth.users (id) on delete cascade,
  owner_email  text not null,
  member_email text not null,
  permissions  jsonb not null check (public.valid_permissions(permissions)),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (owner_id, member_id),
  check (owner_id <> member_id)
);
create index account_members_member_idx on public.account_members (member_id);

create table public.account_invites (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  email       text not null check (email = lower(email) and email like '%@%'),
  permissions jsonb not null check (public.valid_permissions(permissions)),
  token_hash  text not null unique,
  invited_by  uuid references auth.users (id) on delete set null,
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index account_invites_owner_idx on public.account_invites (owner_id);

/** True when the caller owns the account or is a member with at least `p_level` on `p_area`. */
create or replace function public.can_access(p_owner uuid, p_area text, p_level text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select p_owner = (select auth.uid()) or exists (
    select 1 from public.account_members m
    where m.owner_id = p_owner and m.member_id = (select auth.uid())
      and case when p_level = 'edit' then m.permissions->>p_area = 'edit'
               else m.permissions->>p_area in ('view', 'edit') end
  )
$$;
revoke all on function public.can_access(uuid, text, text) from public, anon;
grant execute on function public.can_access(uuid, text, text) to authenticated;

/* ---------- row-level security on account data ---------- */

drop policy if exists "own receipts" on public.receipts;
create policy "receipts read" on public.receipts for select using (public.can_access(user_id, 'receipts', 'view'));
create policy "receipts insert" on public.receipts for insert with check (public.can_access(user_id, 'receipts', 'edit'));
create policy "receipts update" on public.receipts for update
  using (public.can_access(user_id, 'receipts', 'edit')) with check (public.can_access(user_id, 'receipts', 'edit'));
create policy "receipts delete" on public.receipts for delete using (public.can_access(user_id, 'receipts', 'edit'));

-- Reports read line items too (write-offs, inventory), so either area can view them.
drop policy if exists "own line items" on public.line_items;
create policy "line items read" on public.line_items for select
  using (public.can_access(user_id, 'receipts', 'view') or public.can_access(user_id, 'reports', 'view'));
create policy "line items insert" on public.line_items for insert with check (
  public.can_access(user_id, 'receipts', 'edit')
  and exists (select 1 from public.receipts r where r.id = receipt_id and r.user_id = line_items.user_id)
);
-- Report editors may re-file items (tax line, business %) from the write-off finder.
create policy "line items update" on public.line_items for update
  using (public.can_access(user_id, 'receipts', 'edit') or public.can_access(user_id, 'reports', 'edit'))
  with check (
    (public.can_access(user_id, 'receipts', 'edit') or public.can_access(user_id, 'reports', 'edit'))
    and exists (select 1 from public.receipts r where r.id = receipt_id and r.user_id = line_items.user_id)
  );
create policy "line items delete" on public.line_items for delete using (public.can_access(user_id, 'receipts', 'edit'));

-- Reports need receipt headers (dates, stores, totals) as well.
create policy "receipts read for reports" on public.receipts for select using (public.can_access(user_id, 'reports', 'view'));

drop policy if exists "own categories" on public.categories;
create policy "categories read" on public.categories for select using (
  public.can_access(user_id, 'receipts', 'view') or public.can_access(user_id, 'reports', 'view')
  or public.can_access(user_id, 'settings', 'view')
);
create policy "categories write" on public.categories for all
  using (public.can_access(user_id, 'settings', 'edit')) with check (public.can_access(user_id, 'settings', 'edit'));

drop policy if exists "own trips" on public.trips;
create policy "trips read" on public.trips for select using (public.can_access(user_id, 'reports', 'view'));
create policy "trips write" on public.trips for all
  using (public.can_access(user_id, 'reports', 'edit')) with check (public.can_access(user_id, 'reports', 'edit'));

drop policy if exists "own connections read" on public.email_connections;
create policy "connections read" on public.email_connections for select using (public.can_access(user_id, 'settings', 'view'));

drop policy if exists "own profile" on public.profiles;
create policy "profile read" on public.profiles for select using (
  user_id = (select auth.uid()) or public.can_access(user_id, 'receipts', 'view')
  or public.can_access(user_id, 'reports', 'view') or public.can_access(user_id, 'settings', 'view')
);
drop policy if exists "own profile update" on public.profiles;
create policy "profile update" on public.profiles for update
  using (public.can_access(user_id, 'settings', 'edit') or public.can_access(user_id, 'reports', 'edit'))
  with check (public.can_access(user_id, 'settings', 'edit') or public.can_access(user_id, 'reports', 'edit'));

-- Members may only change the profile fields their area covers.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.user_id = (select auth.uid()) then
    return new; -- service role or the owner
  end if;
  if new.onboarded_at is distinct from old.onboarded_at then
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
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Receipt files live under {owner_id}/… in the private bucket. A folder that isn't a user id never matches.
create or replace function public.try_uuid(t text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return t::uuid;
exception when others then
  return null;
end $$;

drop policy if exists "receipts read own" on storage.objects;
drop policy if exists "receipts upload own" on storage.objects;
drop policy if exists "receipts delete own" on storage.objects;
create policy "receipt files read" on storage.objects for select to authenticated using (
  bucket_id = 'receipts' and public.can_access(public.try_uuid((storage.foldername(name))[1]), 'receipts', 'view')
);
create policy "receipt files upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'receipts' and public.can_access(public.try_uuid((storage.foldername(name))[1]), 'receipts', 'edit')
);
create policy "receipt files delete" on storage.objects for delete to authenticated using (
  bucket_id = 'receipts' and public.can_access(public.try_uuid((storage.foldername(name))[1]), 'receipts', 'edit')
);

/* ---------- team tables ---------- */

alter table public.account_members enable row level security;
alter table public.account_invites enable row level security;

create policy "members read" on public.account_members for select using (
  owner_id = (select auth.uid()) or member_id = (select auth.uid()) or public.can_access(owner_id, 'team', 'edit')
);
create policy "members update" on public.account_members for update
  using (public.can_access(owner_id, 'team', 'edit')) with check (public.can_access(owner_id, 'team', 'edit'));
-- Team managers remove people; anyone can leave an account.
create policy "members delete" on public.account_members for delete
  using (public.can_access(owner_id, 'team', 'edit') or member_id = (select auth.uid()));
-- Supabase grants every table to anon/authenticated by default; narrow it to what the policies need.
revoke all on public.account_members from anon, authenticated;
revoke all on public.account_invites from anon, authenticated;
grant select, delete on public.account_members to authenticated;
grant update (permissions, updated_at) on public.account_members to authenticated;

-- Only the owner can hand out team management, and nobody can change their own access.
create or replace function public.guard_member_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.owner_id = (select auth.uid()) then
    new.updated_at := now();
    return new;
  end if;
  if new.member_id = (select auth.uid()) then
    raise exception 'You can''t change your own access';
  end if;
  if new.permissions->>'team' = 'edit' or old.permissions->>'team' = 'edit' then
    raise exception 'Only the account owner can change who manages the team';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger account_members_guard before update on public.account_members
  for each row execute function public.guard_member_update();

create or replace function public.guard_member_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or old.owner_id = (select auth.uid()) or old.member_id = (select auth.uid()) then
    return old; -- service role, the owner, or someone leaving
  end if;
  if old.permissions->>'team' = 'edit' then
    raise exception 'Only the account owner can remove a team manager';
  end if;
  return old;
end $$;
create trigger account_members_guard_delete before delete on public.account_members
  for each row execute function public.guard_member_delete();

create policy "invites read" on public.account_invites for select using (public.can_access(owner_id, 'team', 'edit'));
create policy "invites revoke" on public.account_invites for update
  using (public.can_access(owner_id, 'team', 'edit')) with check (public.can_access(owner_id, 'team', 'edit'));
grant select (id, owner_id, email, permissions, expires_at, accepted_at, revoked_at, created_at) on public.account_invites to authenticated;
grant update (revoked_at) on public.account_invites to authenticated;

/* ---------- invite flow (token never stored in plain text) ---------- */

/** Creates an invite link token for `p_email`. Replaces any pending invite for the same email. */
create or replace function public.create_invite(p_owner uuid, p_email text, p_permissions jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_token text;
begin
  if not public.can_access(p_owner, 'team', 'edit') then
    raise exception 'You don''t have permission to invite people to this account';
  end if;
  if not public.valid_permissions(p_permissions) then
    raise exception 'Invalid permissions';
  end if;
  if p_permissions->>'team' = 'edit' and p_owner <> (select auth.uid()) then
    raise exception 'Only the account owner can invite team managers';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if exists (select 1 from auth.users u where u.id = p_owner and lower(u.email) = v_email) then
    raise exception 'That''s the account owner''s own email';
  end if;
  if exists (select 1 from public.account_members m where m.owner_id = p_owner and lower(m.member_email) = v_email) then
    raise exception '% already has access — change their permissions instead', v_email;
  end if;
  update public.account_invites set revoked_at = now()
    where owner_id = p_owner and email = v_email and accepted_at is null and revoked_at is null;
  v_token := 'rci_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.account_invites (owner_id, email, permissions, token_hash, invited_by)
  values (p_owner, v_email, p_permissions, encode(extensions.digest(v_token, 'sha256'), 'hex'), (select auth.uid()));
  return v_token;
end $$;

/** What an invite link is for (shown before signing in). */
create or replace function public.invite_info(p_token text)
returns table (owner_email text, email text, permissions jsonb, status text)
language sql stable security definer set search_path = '' as $$
  select u.email::text, i.email, i.permissions,
    case when i.revoked_at is not null then 'revoked'
         when i.accepted_at is not null then 'accepted'
         when i.expires_at < now() then 'expired'
         else 'pending' end
  from public.account_invites i join auth.users u on u.id = i.owner_id
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

/** Accepts an invite for the signed-in user, whose email must match the invite. Returns the owner id. */
create or replace function public.accept_invite(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.account_invites;
  v_uid uuid := (select auth.uid());
  v_email text;
  v_owner_email text;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  select * into v_inv from public.account_invites
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') for update;
  if not found or v_inv.revoked_at is not null then raise exception 'This invite link isn''t valid anymore'; end if;
  if v_inv.accepted_at is not null then raise exception 'This invite was already used'; end if;
  if v_inv.expires_at < now() then raise exception 'This invite expired — ask for a new one'; end if;
  select lower(email) into v_email from auth.users where id = v_uid;
  if v_email is distinct from v_inv.email then
    raise exception 'This invite is for %. Sign in with that email to accept it.', v_inv.email;
  end if;
  if v_inv.owner_id = v_uid then raise exception 'You already own this account'; end if;
  select email into v_owner_email from auth.users where id = v_inv.owner_id;

  insert into public.account_members (owner_id, member_id, owner_email, member_email, permissions, invited_by)
  values (v_inv.owner_id, v_uid, v_owner_email, v_email, v_inv.permissions, v_inv.invited_by)
  on conflict (owner_id, member_id) do update set permissions = excluded.permissions, updated_at = now();
  update public.account_invites set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  -- People who join a team skip the new-account setup guide.
  update public.profiles set onboarded_at = coalesce(onboarded_at, now()) where user_id = v_uid;
  return v_inv.owner_id;
end $$;

revoke all on function public.create_invite(uuid, text, jsonb) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.invite_info(text) from public;
grant execute on function public.create_invite(uuid, text, jsonb) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.invite_info(text) to anon, authenticated;
