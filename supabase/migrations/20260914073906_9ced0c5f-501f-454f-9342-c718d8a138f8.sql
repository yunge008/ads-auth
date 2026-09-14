-- 归并超时根因：汇率子查询里又扫了一遍 ad_upload_rows，而 upload_id 的行数估算严重偏低（估 1 行 / 实际 10 万行），
-- 规划器因此选了嵌套循环，把「本批次币种」子查询对每个归并组重算一次 → 10 万行 × 8 万组，必然超时。
-- 修法：直接 LEFT JOIN 很小的 gmv_exchange_rates（按归并后的币种匹配），彻底去掉对 ad_upload_rows 的二次扫描；
-- 同时把 src 固定为 MATERIALIZED，避免被内联后再次被嵌套循环重算。

CREATE OR REPLACE FUNCTION public.attribution_build_upload_agg(_upload_id uuid)
RETURNS TABLE (agg_rows integer, raw_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
DECLARE
  _country text;
  _month text;
  _agg integer;
  _raw bigint;
BEGIN
  SELECT u.country, u.month INTO _country, _month FROM public.ad_uploads u WHERE u.id = _upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '上传批次不存在: %', _upload_id;
  END IF;

  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;

  DELETE FROM public.ad_upload_agg WHERE upload_id = _upload_id;

  WITH src AS MATERIALIZED (
    SELECT
      r.vid,
      btrim(r.tt_account_name) AS account_name,
      r.product_id,
      r.creative_type,
      upper(coalesce(nullif(btrim(r.currency), ''), 'USD')) AS currency,
      min(r.posted_at) AS posted_at,
      count(*)::integer AS rows_count,
      sum(r.cost) AS cost,
      sum(r.gross_revenue) AS gross_revenue,
      sum(r.orders)::bigint AS orders,
      sum(coalesce(r.impressions, 0))::bigint AS impressions,
      sum(coalesce(r.clicks, 0))::bigint AS clicks
    FROM public.ad_upload_rows r
    WHERE r.upload_id = _upload_id
    GROUP BY
      r.vid,
      btrim(r.tt_account_name),
      r.product_id,
      r.creative_type,
      upper(coalesce(nullif(btrim(r.currency), ''), 'USD'))
  )
  INSERT INTO public.ad_upload_agg (
    upload_id, country, month, vid, account_name, product_id, creative_type, currency,
    posted_at, rows_count, cost, gross_revenue, orders, impressions, clicks,
    usd_rate, gmv_usd, cost_usd
  )
  SELECT
    _upload_id,
    upper(btrim(_country)),
    _month,
    s.vid, s.account_name, s.product_id, s.creative_type, s.currency,
    s.posted_at, s.rows_count, s.cost, s.gross_revenue, s.orders, s.impressions, s.clicks,
    rt.usd_rate,
    CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE s.gross_revenue / rt.usd_rate END,
    CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE s.cost / rt.usd_rate END
  FROM src s
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN s.currency = 'USD' THEN coalesce(
               (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                 WHERE er.currency = 'USD' AND er.enabled = true AND er.usd_rate > 0), 1)
             ELSE (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                    WHERE er.currency = s.currency AND er.enabled = true AND er.usd_rate > 0)
           END AS usd_rate
  ) rt ON true;

  GET DIAGNOSTICS _agg = ROW_COUNT;
  RETURN QUERY SELECT _agg, _raw;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_build_upload_agg(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.attribution_build_upload_agg_part(
  _upload_id uuid, _parts integer, _part integer
)
RETURNS TABLE (agg_rows integer, raw_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
DECLARE
  _country text;
  _month text;
  _agg integer;
  _raw bigint;
BEGIN
  IF _parts < 1 OR _part < 0 OR _part >= _parts THEN
    RAISE EXCEPTION '分片参数不合法: parts=%, part=%', _parts, _part;
  END IF;

  SELECT u.country, u.month INTO _country, _month FROM public.ad_uploads u WHERE u.id = _upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '上传批次不存在: %', _upload_id;
  END IF;

  WITH src AS MATERIALIZED (
    SELECT
      r.vid,
      btrim(r.tt_account_name) AS account_name,
      r.product_id,
      r.creative_type,
      upper(coalesce(nullif(btrim(r.currency), ''), 'USD')) AS currency,
      min(r.posted_at) AS posted_at,
      count(*)::integer AS rows_count,
      sum(r.cost) AS cost,
      sum(r.gross_revenue) AS gross_revenue,
      sum(r.orders)::bigint AS orders,
      sum(coalesce(r.impressions, 0))::bigint AS impressions,
      sum(coalesce(r.clicks, 0))::bigint AS clicks
    FROM public.ad_upload_rows r
    WHERE r.upload_id = _upload_id
      AND mod(
            abs(hashtextextended(
              concat_ws(
                chr(31),
                coalesce(r.vid, ''),
                btrim(coalesce(r.tt_account_name, '')),
                coalesce(r.product_id, ''),
                coalesce(r.creative_type, ''),
                upper(coalesce(nullif(btrim(r.currency), ''), 'USD'))
              ),
              0)),
            _parts) = _part
    GROUP BY
      r.vid,
      btrim(r.tt_account_name),
      r.product_id,
      r.creative_type,
      upper(coalesce(nullif(btrim(r.currency), ''), 'USD'))
  )
  INSERT INTO public.ad_upload_agg (
    upload_id, country, month, vid, account_name, product_id, creative_type, currency,
    posted_at, rows_count, cost, gross_revenue, orders, impressions, clicks,
    usd_rate, gmv_usd, cost_usd
  )
  SELECT
    _upload_id,
    upper(btrim(_country)),
    _month,
    s.vid, s.account_name, s.product_id, s.creative_type, s.currency,
    s.posted_at, s.rows_count, s.cost, s.gross_revenue, s.orders, s.impressions, s.clicks,
    rt.usd_rate,
    CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE s.gross_revenue / rt.usd_rate END,
    CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE s.cost / rt.usd_rate END
  FROM src s
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN s.currency = 'USD' THEN coalesce(
               (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                 WHERE er.currency = 'USD' AND er.enabled = true AND er.usd_rate > 0), 1)
             ELSE (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                    WHERE er.currency = s.currency AND er.enabled = true AND er.usd_rate > 0)
           END AS usd_rate
  ) rt ON true
  ON CONFLICT (upload_id, vid, account_name, product_id, creative_type, currency) DO NOTHING;

  GET DIAGNOSTICS _agg = ROW_COUNT;

  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;
  RETURN QUERY SELECT _agg, _raw;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_build_upload_agg_part(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg_part(uuid, integer, integer) TO service_role;