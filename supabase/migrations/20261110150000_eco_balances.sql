-- ECO 代理商后台余额快照：由 Lovable 服务端路由（Cloudflare 出口）同步写入，Edge Function balance-alert 只读。
-- 原因：Supabase 出口 IP 访问 ECO 全部超时（疑似被 ECO 拦截），Cloudflare 出口正常。
CREATE TABLE IF NOT EXISTS public.eco_balances (
  advertiser_id text PRIMARY KEY,           -- = TikTok advertiser_id（ECO adAccountId）
  name          text,
  total         numeric,                    -- totalBalance
  frozen        numeric,                    -- frozenBalance
  available     numeric,                    -- total - frozen（ECO 页面「可用余额」）
  consumption   numeric,                    -- 近 10 天消耗（对账用）
  currency      text,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.eco_balances TO service_role;
ALTER TABLE public.eco_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.eco_balances FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.balance_alert_settings
  ADD COLUMN IF NOT EXISTS eco_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS eco_sync_count int,
  ADD COLUMN IF NOT EXISTS eco_sync_error text,
  ADD COLUMN IF NOT EXISTS eco_sync_error_at timestamptz;
