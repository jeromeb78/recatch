-- Trigger functions aren't meant to be called over the API.
revoke all on function public.guard_member_update() from public, anon, authenticated;
revoke all on function public.guard_member_delete() from public, anon, authenticated;
revoke all on function public.guard_profile_update() from public, anon, authenticated;
