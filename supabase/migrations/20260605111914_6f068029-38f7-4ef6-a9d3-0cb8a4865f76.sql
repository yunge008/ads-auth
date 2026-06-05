ALTER TABLE public.gmv_max_vid_daily
  ADD COLUMN IF NOT EXISTS campaign_name text,
  ADD COLUMN IF NOT EXISTS campaign_operation_status text;