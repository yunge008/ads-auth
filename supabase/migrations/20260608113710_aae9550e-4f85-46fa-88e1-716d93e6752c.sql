CREATE INDEX IF NOT EXISTS gmv_max_vid_daily_country_stat_date_idx
  ON public.gmv_max_vid_daily (country, stat_date);
CREATE INDEX IF NOT EXISTS gmv_max_vid_daily_adv_stat_date_idx
  ON public.gmv_max_vid_daily (advertiser_id, stat_date);
CREATE INDEX IF NOT EXISTS gmv_max_vid_daily_vid_idx
  ON public.gmv_max_vid_daily (vid);
CREATE INDEX IF NOT EXISTS gmv_max_vid_daily_stat_date_brin
  ON public.gmv_max_vid_daily USING BRIN (stat_date);