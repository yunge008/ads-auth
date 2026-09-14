-- 大批次归并分片执行：单次 HTTP 请求做完 10 万行的归并会顶到网关超时（upstream request timeout），
-- 而整个归并是一个事务，超时即回滚——重试多少次都是同样的结果，批次永远卡在「上传中」。
--
-- 拆成三步，每一步都是独立事务、单独一次请求，客户端按片循环调用：
--   1) attribution_clear_upload_agg       清掉该批次上一轮的归并结果（很快）
--   2) attribution_build_upload_agg_part  只归并「归并键哈希 % _parts = _part」的那一份
--   3) attribution_finalize_mark          汇率校验 + 回填合计 + 置为 READY
--
-- 分片条件作用在归并键上，所以同一个归并组永远只会落在同一片里，不会被切开重复计数。
-- 原来的一次性 attribution_finalize_upload 保留不动，小文件仍然走它，一次请求就完事。

CREATE OR REPLACE FUNCTION public.attribution_clear_upload_agg(_upload_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  _n integer;
BEGIN
  DELETE FROM public.ad_upload_agg WHERE upload_id = _upload_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_clear_upload_agg(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_clear_upload_agg(uuid) TO service_role;

-- 归并一个分片。键与值的口径和 attribution_build_upload_agg 完全一致，只是多了一个分片过滤。
CREATE OR REPLACE FUNCTION public.attribution_build_upload_agg_part(
  _upload_id uuid, _parts integer, _part integer
)
RETURNS TABLE (agg_rows integer, raw_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
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

  WITH src AS (
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
      -- 分片键 = 归并键本身，保证同一组只落在同一片
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
    rate.usd_rate,
    CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE s.gross_revenue / rate.usd_rate END,
    CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE s.cost / rate.usd_rate END
  FROM src s
  LEFT JOIN (
    SELECT c.currency,
           CASE WHEN c.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END AS usd_rate
    FROM (
      SELECT DISTINCT upper(coalesce(nullif(btrim(r2.currency), ''), 'USD')) AS currency
      FROM public.ad_upload_rows r2
      WHERE r2.upload_id = _upload_id
    ) c
    LEFT JOIN public.gmv_exchange_rates er
      ON er.currency = c.currency AND er.enabled = true AND er.usd_rate > 0
  ) AS rate ON rate.currency = s.currency
  -- 同一片重跑时不重复插入（唯一键就是归并键）
  ON CONFLICT (upload_id, vid, account_name, product_id, creative_type, currency) DO NOTHING;

  GET DIAGNOSTICS _agg = ROW_COUNT;

  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;
  RETURN QUERY SELECT _agg, _raw;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_build_upload_agg_part(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg_part(uuid, integer, integer) TO service_role;

-- 收尾：汇率校验 → 回填合计 → 置为 READY。与 attribution_finalize_upload 的后半段口径一致。
CREATE OR REPLACE FUNCTION public.attribution_finalize_mark(_upload_id uuid)
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
SET statement_timeout = '120s'
AS $$
DECLARE
  _agg integer;
  _raw bigint;
  _cost numeric;
  _revenue numeric;
  _missing text[];
BEGIN
  SELECT count(*)::integer INTO _agg FROM public.ad_upload_agg a WHERE a.upload_id = _upload_id;
  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;

  SELECT array_agg(DISTINCT a.currency ORDER BY a.currency)
  INTO _missing
  FROM public.ad_upload_agg AS a
  LEFT JOIN public.gmv_exchange_rates AS er
    ON er.currency = a.currency AND er.enabled = true AND er.usd_rate > 0
  WHERE a.upload_id = _upload_id
    AND a.currency <> 'USD'
    AND er.currency IS NULL;

  IF coalesce(array_length(_missing, 1), 0) > 0 THEN
    RETURN QUERY SELECT _agg, _raw, NULL::numeric, NULL::numeric, _missing;
    RETURN;
  END IF;

  -- 归并时已按当时汇率折过美元，这里直接相加，不再重复除汇率
  SELECT coalesce(sum(a.cost_usd), 0), coalesce(sum(a.gmv_usd), 0)
  INTO _cost, _revenue
  FROM public.ad_upload_agg a
  WHERE a.upload_id = _upload_id;

  UPDATE public.ad_uploads
  SET row_count = _raw,
      total_cost = _cost,
      total_revenue = _revenue,
      status = 'READY',
      attributed_at = now()
  WHERE id = _upload_id;

  RETURN QUERY SELECT _agg, _raw, _cost, _revenue, ARRAY[]::text[];
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_finalize_mark(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_finalize_mark(uuid) TO service_role;
