ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS usd_rate numeric;
ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS gmv_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS cost_usd numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ad_upload_agg.usd_rate IS '归并时用的汇率（1 美元 = 多少本币）。NULL = 当时缺该币种汇率或尚未补算，gmv_usd/cost_usd 记 0。';

CREATE INDEX IF NOT EXISTS ad_upload_agg_usd_backfill_idx
  ON public.ad_upload_agg(upload_id) WHERE usd_rate IS NULL;