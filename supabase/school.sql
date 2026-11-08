-- Проверка расписания колледжа: запускать функцию school каждые 5 минут.
-- Функция сама решает по немецкому времени, нужно ли сейчас заходить на сайт.
-- Запустить один раз в Supabase: SQL Editor -> New snippet -> вставить -> Run.

select cron.unschedule('kalendar-school') where exists (select 1 from cron.job where jobname = 'kalendar-school');
select cron.schedule('kalendar-school', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://iqxlgaefulwklbsmecym.supabase.co/functions/v1/school',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
