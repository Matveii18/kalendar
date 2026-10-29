-- Уведомления: подписки устройств и журнал отправленных напоминаний.
-- Запустить один раз в Supabase: SQL Editor -> New snippet -> вставить -> Run.

create table if not exists public.push_subs (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint   text primary key,
  sub        jsonb not null,
  device     text,
  created_at timestamptz not null default now()
);

alter table public.push_subs enable row level security;
drop policy if exists "own subs" on public.push_subs;
create policy "own subs" on public.push_subs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
grant select, insert, update, delete on public.push_subs to authenticated;
revoke all on public.push_subs from anon;

-- Чтобы одно напоминание не пришло дважды. Доступ только у серверной функции.
create table if not exists public.push_log (
  user_id uuid not null references auth.users on delete cascade,
  key     text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

-- Каждую минуту запускать функцию notify
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('kalendar-notify') where exists (select 1 from cron.job where jobname = 'kalendar-notify');
select cron.schedule('kalendar-notify', '* * * * *', $$
  select net.http_post(
    url := 'https://iqxlgaefulwklbsmecym.supabase.co/functions/v1/notify',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- Старые записи журнала чистим раз в сутки
select cron.unschedule('kalendar-log-cleanup') where exists (select 1 from cron.job where jobname = 'kalendar-log-cleanup');
select cron.schedule('kalendar-log-cleanup', '17 3 * * *', $$
  delete from public.push_log where sent_at < now() - interval '30 days';
$$);
