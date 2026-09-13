CREATE OR REPLACE FUNCTION public.attribution_month_reconcile(_month text, _run_id uuid DEFAULT NULL)
RETURNS TABLE (
  scope text,
  creative_type text,
  bucket text,
  rows_count bigint,
  keys_count bigint,
  gmv_usd numeric,
  gmv_native numeric,
  no_rate_rows bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT
    'AGG'::text,
    a.creative_type,
    ''::text,
    sum(a.rows_count)::bigint,
    count(*)::bigint,
    sum(a.gmv_usd),
    sum(a.gross_revenue),
    count(*) FILTER (WHERE a.usd_rate IS NULL)::bigint
  FROM public.ad_upload_agg a
  JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
  WHERE a.month = _month
  GROUP BY a.creative_type

  UNION ALL

  SELECT
    'RUN'::text,
    r.creative_type,
    r.bucket,
    sum(r.rows_count)::bigint,
    count(*)::bigint,
    sum(r.gmv_usd),
    sum(r.gross_revenue),
    count(*) FILTER (WHERE NOT r.has_rate)::bigint
  FROM public.attribution_run_rows r
  WHERE _run_id IS NOT NULL AND r.run_id = _run_id
  GROUP BY r.creative_type, r.bucket;
$$;

REVOKE ALL ON FUNCTION public.attribution_month_reconcile(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_month_reconcile(text, uuid) TO service_role;