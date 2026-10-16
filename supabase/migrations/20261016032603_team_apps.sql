-- Team members can use the phone Shortcut, the browser extension and the Claude connector for an account they were
-- invited to. Each connection remembers the account it was made for (null = the creator's own account). The member's
-- access is checked again every time a connection is used, so removing someone, or lowering their access, cuts off
-- their extension, Shortcut and Claude right away.

alter table public.api_tokens   add column if not exists account_id uuid references auth.users (id) on delete cascade;
alter table public.oauth_codes  add column if not exists account_id uuid references auth.users (id) on delete cascade;
alter table public.oauth_tokens add column if not exists account_id uuid references auth.users (id) on delete cascade;
grant select (account_id) on public.oauth_tokens to authenticated;

-- Extension and Shortcut codes capture receipts, so making one for someone else's account needs receipts edit there
-- (can_access also applies the owner's two-step sign-in requirement).
create or replace function public.check_token_account() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.account_id is not null and new.account_id <> new.user_id
     and not public.can_access(new.account_id, 'receipts', 'edit') then
    raise exception 'You need permission to add receipts to that account';
  end if;
  return new;
end $$;

create trigger api_tokens_account before insert or update of account_id, user_id on public.api_tokens
  for each row execute function public.check_token_account();
