
ALTER TABLE public.gmv_max_vid_daily
  ADD COLUMN IF NOT EXISTS item_id text,
  ADD COLUMN IF NOT EXISTS tt_account_name text,
  ADD COLUMN IF NOT EXISTS tt_account_authorization_type text,
  ADD COLUMN IF NOT EXISTS shop_content_type text,
  ADD COLUMN IF NOT EXISTS ad_video_view_rate_2s numeric,
  ADD COLUMN IF NOT EXISTS ad_video_view_rate_6s numeric,
  ADD COLUMN IF NOT EXISTS ad_video_view_rate_p25 numeric,
  ADD COLUMN IF NOT EXISTS ad_video_view_rate_p50 numeric,
  ADD COLUMN IF NOT EXISTS ad_video_view_rate_p75 numeric,
  ADD COLUMN IF NOT EXISTS ad_video_view_rate_p100 numeric;
