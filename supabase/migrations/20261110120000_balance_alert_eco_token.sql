-- ECO 后台登录令牌缓存（有效期 24h）：一天只登录一次，减少触发 ECO 风控。表 RLS 开、仅 service_role 可读写。
ALTER TABLE public.balance_alert_settings
  ADD COLUMN IF NOT EXISTS eco_token text,
  ADD COLUMN IF NOT EXISTS eco_token_exp timestamptz;
