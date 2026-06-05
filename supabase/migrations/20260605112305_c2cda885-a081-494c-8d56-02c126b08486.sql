CREATE TABLE IF NOT EXISTS public.gmv_max_vid_meta (
  vid text PRIMARY KEY,
  campaign_id text,
  item_group_id text,
  advertiser_id text,
  title text,
  tt_account_name text,
  tt_account_authorization_type text,
  shop_content_type text,
  pulled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.gmv_max_vid_meta TO authenticated;
GRANT ALL ON public.gmv_max_vid_meta TO service_role;
ALTER TABLE public.gmv_max_vid_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.gmv_max_vid_meta
  TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER gmv_max_vid_meta_touch BEFORE UPDATE ON public.gmv_max_vid_meta
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX IF NOT EXISTS gmv_max_vid_meta_adv_idx ON public.gmv_max_vid_meta(advertiser_id);