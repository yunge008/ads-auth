-- 建联表「其他同事已建联」(U 列) 改脚本定时回写：每 10 分钟（:03/:13/…/:53，避开整点与 :25 等已有任务）
--   pg_cron → /api/public/hooks/xinpin-calc-cron (body {"tables":["u"]}) → Edge Function xinpin-tuiguang-calc(mode=write)
-- 取代未执行过的 20261128140000（每小时统计回写，负责人已改回公式，不再需要，文件已删）。
-- 建好**默认停用**；部署 + 配环境变量 + Publish + 手动跑一次 dryrun 核对后，再执行：
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'xinpin-u-10min'), active := true);
DO $$
DECLARE
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/xinpin-calc-cron';
  cmd text;
BEGIN
  PERFORM cron.unschedule('xinpin-calc-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xinpin-calc-hourly');
  cmd := format(
    'select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{"tables":["u"]}''::jsonb, timeout_milliseconds := 150000);',
    url
  );
  PERFORM cron.unschedule('xinpin-u-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xinpin-u-10min');
  PERFORM cron.schedule('xinpin-u-10min', '3-59/10 * * * *', cmd);
  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'xinpin-u-10min'), active := false);
END $$;
