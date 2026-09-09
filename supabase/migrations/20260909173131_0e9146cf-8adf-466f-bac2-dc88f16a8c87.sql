CREATE INDEX IF NOT EXISTS ad_upload_rows_unmatched_trend_idx
ON public.ad_upload_rows (upload_id, tt_account_name, currency)
INCLUDE (gross_revenue)
WHERE attr_bucket = 'UNMATCHED';