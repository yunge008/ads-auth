-- 每晚自动同步飞书基础数据：pg_cron(北京 23:00 / UTC 15:00) → /api/public/hooks/feishu-sync-cron
--   ① 发样及素材统计「同步飞书数据」
--   ② GMV 归因「同步达人登记」
--   ③ GMV 归因「同步 GMV 目标」
--   ④ GMV 归因「同步站点交接」
--
-- 排在归因快照（attribution-snapshot-nightly，北京 23:30）之前半小时：
-- 快照按「当下的登记数据」现算，先同步完登记/目标/交接，当晚的快照才吃得到当天的新数据。
--
-- 域名与 apikey 不写死在迁移里（避免密钥入库），而是从已有的 cron job 命令里抄一份。
DO $$
DECLARE
  _src   text;
  _base  text;
  _key   text;
  _cmd   text;
BEGIN
  -- 任取一个已有的 hook 类 job 作为模板（先找归因快照，其次自动授权）
  SELECT command INTO _src
  FROM cron.job
  WHERE command LIKE '%/api/public/hooks/%'
  ORDER BY CASE
    WHEN command LIKE '%attribution-cron%' THEN 0
    WHEN command LIKE '%authorize-cron%' THEN 1
    ELSE 2
  END
  LIMIT 1;

  IF _src IS NULL THEN
    RAISE WARNING '找不到任何 /api/public/hooks/ 的 cron job，无法推断站点域名与 apikey；请手动 cron.schedule 建立 feishu-sync-nightly';
    RETURN;
  END IF;

  _base := substring(_src from 'https?://[^/]+');
  _key  := substring(_src from '"apikey"\s*:\s*"([^"]+)"');

  IF _base IS NULL OR _key IS NULL THEN
    RAISE WARNING '无法从已有 job 命令里解析出域名或 apikey；请手动 cron.schedule 建立 feishu-sync-nightly';
    RETURN;
  END IF;

  _cmd := format(
    $cmd$select net.http_post(
      url := %L,
      headers := %L::jsonb,
      body := '{}'::jsonb
    );$cmd$,
    _base || '/api/public/hooks/feishu-sync-cron',
    json_build_object('Content-Type', 'application/json', 'apikey', _key)::text
  );

  -- 重跑本迁移时先撤掉旧的，避免同名 job 叠加
  PERFORM cron.unschedule('feishu-sync-nightly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'feishu-sync-nightly');

  PERFORM cron.schedule('feishu-sync-nightly', '0 15 * * *', _cmd);
  RAISE NOTICE 'feishu-sync-nightly scheduled: 0 15 * * * (Beijing 23:00) → %', _base || '/api/public/hooks/feishu-sync-cron';
END;
$$;
