CREATE OR REPLACE FUNCTION public.attribution_unmatched_trend(_months text[])
RETURNS TABLE(country text, account_name text, month text, gmv_usd numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    u.country,
    btrim(r.tt_account_name) AS account_name,
    u.month,
    SUM(
      r.gross_revenue /
      CASE
        WHEN upper(COALESCE(NULLIF(r.currency, ''), 'USD')) = 'USD' THEN 1::numeric
        ELSE er.usd_rate
      END
    ) AS gmv_usd
  FROM public.ad_uploads AS u
  JOIN public.ad_upload_rows AS r ON r.upload_id = u.id
  LEFT JOIN public.gmv_exchange_rates AS er
    ON er.currency = upper(COALESCE(NULLIF(r.currency, ''), 'USD'))
   AND er.enabled = true
  WHERE u.status = 'READY'
    AND u.month = ANY(_months)
    AND r.attr_bucket = 'UNMATCHED'
    AND btrim(COALESCE(r.tt_account_name, '')) <> ''
    AND (
      upper(COALESCE(NULLIF(r.currency, ''), 'USD')) = 'USD'
      OR er.usd_rate > 0
    )
  GROUP BY u.country, btrim(r.tt_account_name), u.month;
$function$;

REVOKE ALL ON FUNCTION public.attribution_unmatched_trend(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attribution_unmatched_trend(text[]) TO service_role;