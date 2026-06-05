ALTER TABLE public.gmv_max_vid_daily DROP COLUMN IF EXISTS raw_payload;
ALTER TABLE public.gmv_max_vid_daily ADD COLUMN IF NOT EXISTS currency text;