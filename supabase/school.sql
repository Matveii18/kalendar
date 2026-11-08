-- Расписание колледжа теперь скачивает GitHub Actions (.github/workflows/school.yml),
-- потому что сайт колледжа не пускает серверы Supabase. Задание pg_cron больше не нужно.
-- Запустить один раз в Supabase: SQL Editor -> New snippet -> вставить -> Run.

select cron.unschedule('kalendar-school') where exists (select 1 from cron.job where jobname = 'kalendar-school');
