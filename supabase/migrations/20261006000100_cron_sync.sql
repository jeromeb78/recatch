-- Runs gmail-sync every 30 minutes. Requires these Vault secrets first:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'project_url')
     or not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret') then
    raise exception 'Create the project_url and cron_secret Vault secrets before applying this migration (see README step 5).';
  end if;
end $$;

select cron.unschedule('gmail-sync')
where exists (select 1 from cron.job where jobname = 'gmail-sync');

select cron.schedule(
  'gmail-sync',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/gmail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
