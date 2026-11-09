-- ECO 代理商后台二次验证后的信任设备 ID（登录带 X-Device-Id 免验证）。表本身 RLS 开、仅 service_role 可读写。
ALTER TABLE public.balance_alert_settings
  ADD COLUMN IF NOT EXISTS eco_device_id text,
  ADD COLUMN IF NOT EXISTS eco_device_at timestamptz;
