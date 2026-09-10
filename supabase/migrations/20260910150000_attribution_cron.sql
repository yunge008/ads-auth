-- 每晚 23:30（北京，= UTC 15:30）刷新一次 GMV 归因结果快照。
-- 做法：从已有的自动授权 cron job 里抄出 net.http_post 的 URL 与 headers（里面已经有正确的应用域名和 apikey），
-- 把路径换成 /api/public/hooks/attribution-cron 后新建一个 job，避免把域名/密钥再写死一份到迁移里。
DO $$
DECLARE
  _cmd text;
  _new text;
BEGIN
  SELECT command INTO _cmd
  FROM cron.job
  WHERE command LIKE '%/api/public/hooks/authorize-cron%'
  ORDER BY jobid
  LIMIT 1;

  IF _cmd IS NULL THEN
    RAISE WARNING '找不到 authorize-cron 定时任务，attribution-cron 未创建。请在 SQL Editor 里手动 cron.schedule（见 docs/PLAN.md）。';
    RETURN;
  END IF;

  _new := replace(_cmd, '/api/public/hooks/authorize-cron', '/api/public/hooks/attribution-cron');

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'attribution-snapshot-nightly') THEN
    PERFORM cron.unschedule('attribution-snapshot-nightly');
  END IF;

  PERFORM cron.schedule('attribution-snapshot-nightly', '30 15 * * *', _new);
  RAISE NOTICE 'attribution-snapshot-nightly scheduled: 30 15 * * * (Beijing 23:30)';
END;
$$;
