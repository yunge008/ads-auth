DROP TRIGGER IF EXISTS gmv_max_vid_daily_touch ON public.gmv_max_vid_daily;
DROP TRIGGER IF EXISTS gmv_max_vid_meta_touch ON public.gmv_max_vid_meta;
ALTER TABLE public.gmv_max_vid_daily DROP COLUMN IF EXISTS pulled_at, DROP COLUMN IF EXISTS updated_at;
ALTER TABLE public.gmv_max_vid_meta  DROP COLUMN IF EXISTS pulled_at, DROP COLUMN IF EXISTS updated_at;