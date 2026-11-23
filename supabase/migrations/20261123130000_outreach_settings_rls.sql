-- 补漏：20261117120000_outreach_core.sql 给其余 4 张 outreach_* 表开了 RLS，唯独漏了 outreach_settings
-- （Lovable 安全扫描 Critical：anon key 可读写删该表）。
-- 只有 Edge Function 用 service role 读写（_shared/outreach.ts），service role 绕过 RLS，开 RLS + 不建 policy 不影响功能。
ALTER TABLE public.outreach_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_settings FROM anon, authenticated;
