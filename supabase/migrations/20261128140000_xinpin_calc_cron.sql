-- 新品推广 / 产品推广计划 统计回写（方案④）：每小时 :25（UTC 与新加坡同一分钟）调用
--   pg_cron → /api/public/hooks/xinpin-calc-cron → Edge Function xinpin-tuiguang-calc(mode=write)
-- 建好后**默认停用**（负责人确认方案④、配好 XINPIN_DATA_SPREADSHEET / XINPIN_TARGET_SPREADSHEET 后再启用）：
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'xinpin-calc-hourly'), active := true);
-- :25 落在 API_RATE_LIMITS §7.2「:17–:25 空档」之后、只调飞书，不占 TikTok 任何桶。
DO $$
DECLARE
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/xinpin-calc-cron';
  cmd text;
BEGIN
  cmd := format(
    'select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{}''::jsonb, timeout_milliseconds := 150000);',
    url
  );
  PERFORM cron.unschedule('xinpin-calc-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xinpin-calc-hourly');
  PERFORM cron.schedule('xinpin-calc-hourly', '25 * * * *', cmd);
  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'xinpin-calc-hourly'), active := false);
END $$;
