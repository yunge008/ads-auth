-- 【第 2 步 / 共 3 步】归并时折美元的两个函数 + 存量分批补算。

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

  -- 归并键：站点 × VID × 达人昵称 × 商品ID × 内容类型 × 币种
  -- 归并值：只存可相加的数值（GMV / 成本 / 订单 / 曝光 / 点击）+ 折算后的美元金额。
  -- ROI、CTR、CVR 这类比率不存，出报表时用汇总后的分子分母重算。
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
    s.vid,
    s.account_name,
    s.product_id,
    s.creative_type,
    s.currency,
    s.posted_at,
    s.rows_count,
    s.cost,
    s.gross_revenue,
    s.orders,
    s.impressions,
    s.clicks,
    rate.usd_rate,
    CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE s.gross_revenue / rate.usd_rate END,
    CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE s.cost / rate.usd_rate END
  FROM src s
  -- 先把「本批次出现的币种 → 汇率」做成一张小表再 JOIN。
  -- USD 恒等于 1；其它币种取后台启用中的汇率，缺失则为 NULL（该组不计入美元口径）。
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
  ) AS rate ON rate.currency = s.currency;

  GET DIAGNOSTICS _agg = ROW_COUNT;
  RETURN QUERY SELECT _agg, _raw;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_build_upload_agg(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg(uuid) TO service_role;

-- 汇率改了以后就地重算某月的美元金额（不用重传文件、不用重新归并原始行）
CREATE OR REPLACE FUNCTION public.attribution_rebuild_agg_usd(_month text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
DECLARE
  n integer;
BEGIN
  -- 注意：UPDATE 的目标表不能被 FROM 里的 LATERAL 反向引用（42P10），
  -- 所以先把「币种 → 汇率」做成一张小表，再按币种 JOIN 回来。
  UPDATE public.ad_upload_agg a
  SET usd_rate = rate.usd_rate,
      gmv_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.gross_revenue / rate.usd_rate END,
      cost_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.cost / rate.usd_rate END
  FROM (
    SELECT c.currency,
           CASE WHEN c.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END AS usd_rate
    FROM (SELECT DISTINCT currency FROM public.ad_upload_agg WHERE month = _month) c
    LEFT JOIN public.gmv_exchange_rates er
      ON er.currency = c.currency AND er.enabled = true AND er.usd_rate > 0
  ) AS rate
  WHERE rate.currency = a.currency
    AND a.month = _month
    AND (a.usd_rate IS DISTINCT FROM rate.usd_rate);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_rebuild_agg_usd(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_rebuild_agg_usd(text) TO service_role;


-- 存量补算：一次只处理 _limit 行，返回实际更新的行数。
-- 在 SQL 编辑器里重复执行直到返回 0 即可（每次都是独立事务，不会超时回滚）：
--   select public.attribution_backfill_agg_usd(50000);
-- 不手动跑也行：生成快照时会按月调用 attribution_rebuild_agg_usd 自动补上。
CREATE OR REPLACE FUNCTION public.attribution_backfill_agg_usd(_limit integer DEFAULT 50000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  n integer;
BEGIN
  WITH target AS (
    SELECT id FROM public.ad_upload_agg WHERE usd_rate IS NULL LIMIT GREATEST(_limit, 1)
  ),
  rate AS (
    SELECT c.currency,
           CASE WHEN c.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END AS usd_rate
    FROM (SELECT DISTINCT currency FROM public.ad_upload_agg WHERE usd_rate IS NULL) c
    LEFT JOIN public.gmv_exchange_rates er
      ON er.currency = c.currency AND er.enabled = true AND er.usd_rate > 0
  )
  UPDATE public.ad_upload_agg a
  SET usd_rate = rate.usd_rate,
      gmv_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.gross_revenue / rate.usd_rate END,
      cost_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.cost / rate.usd_rate END
  FROM target, rate
  WHERE a.id = target.id AND rate.currency = a.currency AND rate.usd_rate IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_backfill_agg_usd(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_backfill_agg_usd(integer) TO service_role;
