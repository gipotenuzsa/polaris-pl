-- Polaris: задания pg_cron в Supabase. Выполните вручную в SQL Editor ОДИН раз.
-- Заранее: Database → Extensions → включите pg_cron и pg_net.
--
-- Замените:
--   https://YOUR-SERVICE.onrender.com   → публичный адрес сервера на Render
--   YOUR_CRON_SECRET                    → значение переменной CRON_SECRET на сервере
--
-- 1) Пинг /health раз в 10 минут: Render free засыпает после 15 минут простоя.
-- 2) Тик планировщика раз в минуту: будит сервер и запускает просроченные задачи,
--    напоминания и утреннюю сводку, даже если встроенный таймер не успел сработать.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname in ('polaris-ping', 'polaris-tick');

select cron.schedule(
  'polaris-ping',
  '*/10 * * * *',
  $$ select net.http_get(url := 'https://YOUR-SERVICE.onrender.com/health', timeout_milliseconds := 60000); $$
);

select cron.schedule(
  'polaris-tick',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://YOUR-SERVICE.onrender.com/internal/tick',
       headers := jsonb_build_object('x-cron-secret', 'YOUR_CRON_SECRET', 'content-type', 'application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     ); $$
);

-- Проверка:   select * from cron.job;
-- Журнал:     select * from cron.job_run_details order by start_time desc limit 20;
-- Отключить:  select cron.unschedule('polaris-ping'); select cron.unschedule('polaris-tick');
