-- TikTok Shop 多应用（商家自用应用）+ token 自动刷新（2026-11-23）
--
-- 背景：外部应用审核资料过多，改为每个店铺主体各开一个「商家自用」应用，
--       每个应用有自己的 app_key / app_secret，token 只能配签发它的应用签名。
-- 1. 新表 tts_apps：应用凭据（app_secret 存表，负责人 2026-11-23 决定），RLS 开、无 policy，仅 service role。
--    code='default' = 原应用：app_key 留空时读 Supabase secrets TTS_APP_KEY / TTS_APP_SECRET / TTS_SERVICE_ID。
-- 2. tts_shops 加 app_code（店铺由哪个应用授权）+ 刷新状态。已有店铺归 default。
-- 3. pg_cron `tts-token-refresh`：每天北京 05:17 → /api/public/hooks/tts-token-cron，刷新 48h 内到期的 token。

CREATE TABLE IF NOT EXISTS public.tts_apps (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9-]{1,32}$'),
  name        text NOT NULL,
  app_key     text NOT NULL DEFAULT '',
  app_secret  text NOT NULL DEFAULT '',
  service_id  text NOT NULL DEFAULT '',
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tts_apps ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.tts_apps TO service_role;

INSERT INTO public.tts_apps (code, name) VALUES
  ('default', '原应用'),
  ('mx-ar', 'MX-AR'),
  ('mx-ne', 'MX-NE'),
  ('mx-sj', 'MX-SJ'),
  ('jp', 'JP')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.tts_shops
  ADD COLUMN IF NOT EXISTS app_code text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS last_refresh_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_refresh_error text;

DO $$
DECLARE
  _src text; _base text; _key text;
BEGIN
  SELECT command INTO _src FROM cron.job WHERE command LIKE '%/api/public/hooks/%' LIMIT 1;
  IF _src IS NULL THEN
    RAISE WARNING '找不到任何 /api/public/hooks/ 的 cron job，请手动 cron.schedule 建立 tts-token-refresh';
    RETURN;
  END IF;
  _base := substring(_src from 'https?://[^/]+');
  _key  := substring(_src from '"apikey"\s*:\s*"([^"]+)"');
  IF _base IS NULL OR _key IS NULL THEN
    RAISE WARNING '无法解析域名或 apikey，请手动 cron.schedule';
    RETURN;
  END IF;
  PERFORM cron.unschedule('tts-token-refresh') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tts-token-refresh');
  PERFORM cron.schedule('tts-token-refresh', '17 21 * * *', format(
    $cmd$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 300000);$cmd$,
    _base || '/api/public/hooks/tts-token-cron',
    json_build_object('Content-Type', 'application/json', 'apikey', _key)::text));
  RAISE NOTICE 'tts-token-refresh 17 21 * * * (北京 05:17) scheduled';
END;
$$;
