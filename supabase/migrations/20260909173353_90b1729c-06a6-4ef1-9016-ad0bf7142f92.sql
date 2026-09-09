CREATE OR REPLACE FUNCTION public.attribution_unmatched_trend_json(_months text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'country', grouped.country,
        'account_name', grouped.account_name,
        'month', grouped.month,
        'gmv_usd', grouped.gmv_usd
      )
    ),
    '[]'::jsonb
  )
  FROM (
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
    GROUP BY u.country, btrim(r.tt_account_name), u.month
  ) AS grouped;
$function$;

REVOKE ALL ON FUNCTION public.attribution_unmatched_trend_json(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_unmatched_trend_json(text[]) TO service_role;