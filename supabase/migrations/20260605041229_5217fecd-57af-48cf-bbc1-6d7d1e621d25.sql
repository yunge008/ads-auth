CREATE TABLE IF NOT EXISTS public.tiktok_comment_sync_state (
  advertiser_id text PRIMARY KEY,
  last_synced_until timestamptz,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tiktok_comment_sync_state TO authenticated;
GRANT ALL ON public.tiktok_comment_sync_state TO service_role;
ALTER TABLE public.tiktok_comment_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.tiktok_comment_sync_state FOR ALL USING (false) WITH CHECK (false);
CREATE TRIGGER touch_updated_at_tcss BEFORE UPDATE ON public.tiktok_comment_sync_state FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();