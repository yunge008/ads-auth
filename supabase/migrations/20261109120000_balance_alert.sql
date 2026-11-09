-- 账户余额预警（设置 → 账户余额预警）
--   balance_alert_settings：全局设置（单行 id=1）：预警天数 X、异常日剔除比例、飞书群 chat_id
--   balance_alert_accounts：每个广告户的开关 + 最近一次计算快照（页面秒开，不必每次现拉 TikTok）

CREATE TABLE IF NOT EXISTS public.balance_alert_settings (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  threshold_days  numeric NOT NULL DEFAULT 3 CHECK (threshold_days > 0),
  abnormal_ratio  numeric NOT NULL DEFAULT 0.3 CHECK (abnormal_ratio >= 0 AND abnormal_ratio < 1),
  feishu_chat_id  text,
  feishu_chat_name text,
  last_run_at     timestamptz,
  last_run_summary jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.balance_alert_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.balance_alert_accounts (
  advertiser_id    text PRIMARY KEY,
  enabled          boolean NOT NULL DEFAULT true,
  advertiser_name  text,
  currency         text,
  balance          numeric,          -- 可用余额
  balance_source   text,             -- 余额取自哪个接口/字段
  avg_daily_spend  numeric,          -- 剔除异常日后的正常日均
  valid_days       int,
  window_start     date,
  window_end       date,
  daily            jsonb,            -- [{date,spend,valid}]
  days_left        numeric,
  error            text,
  checked_at       timestamptz,
  last_alerted_at  timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.balance_alert_settings TO service_role;
GRANT ALL ON public.balance_alert_accounts TO service_role;
ALTER TABLE public.balance_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_alert_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.balance_alert_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role only" ON public.balance_alert_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 每天北京 10:00（UTC 02:00）→ /api/public/hooks/balance-alert-cron
-- 域名与 apikey 从已有 hook 类 cron job 命令里抄（同 20260916120000_feishu_sync_cron.sql）
DO $$
DECLARE
  _src text; _base text; _key text; _cmd text;
BEGIN
  SELECT command INTO _src FROM cron.job WHERE command LIKE '%/api/public/hooks/%' LIMIT 1;
  IF _src IS NULL THEN
    RAISE WARNING '找不到任何 /api/public/hooks/ 的 cron job，请手动 cron.schedule 建立 balance-alert-daily';
    RETURN;
  END IF;
  _base := substring(_src from 'https?://[^/]+');
  _key  := substring(_src from '"apikey"\s*:\s*"([^"]+)"');
  IF _base IS NULL OR _key IS NULL THEN
    RAISE WARNING '无法解析域名或 apikey，请手动 cron.schedule 建立 balance-alert-daily';
    RETURN;
  END IF;
  _cmd := format(
    $cmd$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 600000);$cmd$,
    _base || '/api/public/hooks/balance-alert-cron',
    json_build_object('Content-Type', 'application/json', 'apikey', _key)::text
  );
  PERFORM cron.unschedule('balance-alert-daily')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'balance-alert-daily');
  PERFORM cron.schedule('balance-alert-daily', '0 2 * * *', _cmd);
  RAISE NOTICE 'balance-alert-daily scheduled: 0 2 * * * (Beijing 10:00)';
END;
$$;
