-- 将自动授权 cron job 从北京 08:00（UTC 00:00）改为北京 20:00（UTC 12:00）
-- 做法：从 cron.job 读取原 command，unschedule 旧 job，用新时间重建。
DO $$
DECLARE
  _cmd text;
BEGIN
  SELECT command INTO _cmd FROM cron.job WHERE jobname = 'authorize-daily-0800';
  IF _cmd IS NOT NULL THEN
    PERFORM cron.unschedule('authorize-daily-0800');
    PERFORM cron.schedule('authorize-daily-2000', '0 12 * * *', _cmd);
    RAISE NOTICE 'authorize cron rescheduled: 0 12 * * * (Beijing 20:00)';
  ELSE
    RAISE WARNING 'job authorize-daily-0800 not found, skipping';
  END IF;
END;
$$;
