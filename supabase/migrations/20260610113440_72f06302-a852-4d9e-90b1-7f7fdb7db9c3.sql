
-- authorize_cron_state: add service_role-only policy
DROP POLICY IF EXISTS "service role full access" ON public.authorize_cron_state;
CREATE POLICY "service role full access"
  ON public.authorize_cron_state
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- gmv_max_sync_state: remove open authenticated read, enforce service_role only
DROP POLICY IF EXISTS "auth read sync state" ON public.gmv_max_sync_state;
DROP POLICY IF EXISTS "service role full access" ON public.gmv_max_sync_state;
CREATE POLICY "service role full access"
  ON public.gmv_max_sync_state
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- tiktok_comment_sync_state: replace misconfigured false/false policy
DROP POLICY IF EXISTS "service role full access" ON public.tiktok_comment_sync_state;
CREATE POLICY "service role full access"
  ON public.tiktok_comment_sync_state
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
