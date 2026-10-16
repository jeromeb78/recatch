-- Trigger functions aren't meant to be called over the API.
revoke all on function public.check_token_account() from public, anon, authenticated;
