-- 大文件 finalize 只在数据库内完成归并、汇率校验与批次状态更新，
-- 不再把数万条归并结果读回 Edge Function 做即时预览。
CREATE OR REPLACE FUNCTION public.attribution_finalize_upload(_upload_id uuid)
RETURNS TABLE (
  agg_rows integer,
  raw_rows bigint,
  total_cost_usd numeric,
  total_revenue_usd numeric,
  missing_currencies text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
DECLARE
  _agg integer;
  _raw bigint;
  _cost numeric;
  _revenue numeric;
  _missing text[];
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(_upload_id::text, 0)) THEN
    RAISE EXCEPTION '该批次正在归并，请稍后重试';
  END IF;

  SELECT b.agg_rows, b.raw_rows
  INTO _agg, _raw
  FROM public.attribution_build_upload_agg(_upload_id) AS b;

  SELECT array_agg(DISTINCT a.currency ORDER BY a.currency)
  INTO _missing
  FROM public.ad_upload_agg AS a
  LEFT JOIN public.gmv_exchange_rates AS er
    ON er.currency = a.currency
   AND er.enabled = true
   AND er.usd_rate > 0
  WHERE a.upload_id = _upload_id
    AND a.currency <> 'USD'
    AND er.currency IS NULL;

  IF coalesce(array_length(_missing, 1), 0) > 0 THEN
    RETURN QUERY SELECT _agg, _raw, NULL::numeric, NULL::numeric, _missing;
    RETURN;
  END IF;

  SELECT
    coalesce(sum(a.cost / CASE WHEN a.currency = 'USD' THEN 1 ELSE er.usd_rate END), 0),
    coalesce(sum(a.gross_revenue / CASE WHEN a.currency = 'USD' THEN 1 ELSE er.usd_rate END), 0)
  INTO _cost, _revenue
  FROM public.ad_upload_agg AS a
  LEFT JOIN public.gmv_exchange_rates AS er
    ON er.currency = a.currency
   AND er.enabled = true
   AND er.usd_rate > 0
  WHERE a.upload_id = _upload_id;

  UPDATE public.ad_uploads
  SET
    row_count = _raw,
    total_cost = _cost,
    total_revenue = _revenue,
    status = 'READY',
    attributed_at = now()
  WHERE id = _upload_id;

  RETURN QUERY SELECT _agg, _raw, _cost, _revenue, ARRAY[]::text[];
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_finalize_upload(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_finalize_upload(uuid) TO service_role;