CREATE OR REPLACE FUNCTION public.attribution_apply_run(_run_id uuid, _month text)
RETURNS TABLE (
  bucket text, staff text, role text, match_type text, country text, currency text,
  has_rate boolean,
  gmv_native numeric, cost_native numeric, gmv_usd numeric, cost_usd numeric,
  orders bigint, rows_count bigint, vids integer, creators integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
BEGIN
  DELETE FROM public.attribution_run_rows WHERE run_id = _run_id;

  INSERT INTO public.attribution_run_rows (
    run_id, month, country, vid, account_name, product_id, creative_type, currency,
    rows_count, cost, gross_revenue, orders, cost_usd, gmv_usd, has_rate,
    bucket, staff, role, match_type, handover_applied, posted_at
  )
  SELECT
    _run_id,
    _month,
    a.country,
    a.vid,
    a.account_name,
    '',
    a.creative_type,
    CASE WHEN count(DISTINCT a.currency) = 1 THEN min(a.currency) ELSE 'MIXED' END,
    sum(a.rows_count)::integer,
    sum(a.cost),
    sum(a.gross_revenue),
    sum(a.orders)::bigint,
    sum(a.cost_usd),
    sum(a.gmv_usd),
    bool_and(a.usd_rate IS NOT NULL),
    coalesce(k.bucket, 'UNMATCHED'),
    k.staff,
    k.role,
    k.match_type,
    coalesce(k.handover_applied, false),
    min(a.posted_at)
  FROM public.ad_upload_agg a
  JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
  LEFT JOIN public.attribution_run_keys k
    ON k.run_id = _run_id
   AND k.country = a.country
   AND k.vid = a.vid
   AND k.account_name = a.account_name
   AND k.creative_type = a.creative_type
  WHERE a.month = _month
  GROUP BY
    a.country, a.vid, a.account_name, a.creative_type,
    k.bucket, k.staff, k.role, k.match_type, k.handover_applied;

  RETURN QUERY
  SELECT
    x.bucket, x.staff, x.role, x.match_type, x.country, x.currency, x.has_rate,
    sum(x.gross_revenue), sum(x.cost), sum(x.gmv_usd), sum(x.cost_usd),
    sum(x.orders)::bigint, sum(x.rows_count)::bigint,
    0, 0
  FROM public.attribution_run_rows x
  WHERE x.run_id = _run_id
  GROUP BY x.bucket, x.staff, x.role, x.match_type, x.country, x.currency, x.has_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_apply_run(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_apply_run(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.attribution_run_distinct(_run_id uuid)
RETURNS TABLE (scope text, staff text, role text, country text, vids integer, creators integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT
    CASE
      WHEN grouping(r.staff) = 1 THEN 'TOTAL'
      WHEN grouping(r.country) = 1 THEN 'STAFF'
      ELSE 'CELL'
    END AS scope,
    r.staff,
    r.role,
    r.country,
    count(DISTINCT r.vid) FILTER (WHERE r.vid <> '')::integer AS vids,
    count(DISTINCT lower(btrim(r.account_name))) FILTER (WHERE btrim(r.account_name) <> '')::integer AS creators
  FROM public.attribution_run_rows r
  WHERE r.run_id = _run_id AND r.bucket = 'STAFF' AND r.staff IS NOT NULL
  GROUP BY GROUPING SETS ((r.staff, r.role, r.country), (r.staff, r.role), ());
$$;

REVOKE ALL ON FUNCTION public.attribution_run_distinct(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_distinct(uuid) TO service_role;

CREATE INDEX IF NOT EXISTS attribution_run_rows_run_staff_country_idx
  ON public.attribution_run_rows(run_id, staff, country);

CREATE OR REPLACE FUNCTION public.attribution_run_by_type(_run_id uuid)
RETURNS TABLE (
  country text, creative_type text, bucket text,
  gmv_usd numeric, cost_usd numeric, orders bigint, rows_count bigint, vids integer, creators integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT
    r.country,
    r.creative_type,
    r.bucket,
    sum(r.gmv_usd),
    sum(r.cost_usd),
    sum(r.orders)::bigint,
    sum(r.rows_count)::bigint,
    count(DISTINCT r.vid) FILTER (WHERE r.vid <> '')::integer,
    count(DISTINCT lower(btrim(r.account_name))) FILTER (WHERE btrim(r.account_name) <> '')::integer
  FROM public.attribution_run_rows r
  WHERE r.run_id = _run_id
  GROUP BY r.country, r.creative_type, r.bucket;
$$;

REVOKE ALL ON FUNCTION public.attribution_run_by_type(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_by_type(uuid) TO service_role;