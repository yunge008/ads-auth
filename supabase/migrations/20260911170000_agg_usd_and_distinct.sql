-- 两个口径变更：
--
-- 【一】金额在归并时就折成 USD
--   以前是出报表时才按汇率折算，同月多币种文件要一路把币种带到最后。
--   现在 attribution_build_upload_agg 在归并那一刻就用后台维护的汇率算出 gmv_usd / cost_usd 并把
--   当时用的 usd_rate 一起存下来（可追溯、可重算）。后面所有环节只做加法，不再有汇率分支。
--   汇率改了怎么办：跑 attribution_rebuild_agg_usd('YYYY-MM') 就地重算该月的美元金额，不用重传文件。
--
-- 【二】去重计数只按 (同事, 国家)
--   VID 数 / 达人昵称数按整月**所有文件合并后的集合**去重：同月两个 PH 文件（同币种或不同币种、
--   换过广告户都一样）里的同一个 VID 只算一次。除了同事和国家，不加任何其它联合字段。

-- ---------- 1. 归并表存 USD ----------

ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS usd_rate numeric;
ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS gmv_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS cost_usd numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ad_upload_agg.usd_rate IS '归并时用的汇率（1 美元 = 多少本币）。NULL = 当时缺该币种汇率，gmv_usd/cost_usd 记 0。';

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

-- 存量数据：把已有归并行按当前汇率补算一次美元金额
UPDATE public.ad_upload_agg a
SET usd_rate = rate.usd_rate,
    gmv_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.gross_revenue / rate.usd_rate END,
    cost_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.cost / rate.usd_rate END
FROM (
  SELECT c.currency,
         CASE WHEN c.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END AS usd_rate
  FROM (SELECT DISTINCT currency FROM public.ad_upload_agg) c
  LEFT JOIN public.gmv_exchange_rates er
    ON er.currency = c.currency AND er.enabled = true AND er.usd_rate > 0
) AS rate
WHERE rate.currency = a.currency
  AND a.usd_rate IS NULL;

-- ---------- 2. 聚合：只加 USD，不再做汇率分支 ----------

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

  -- 明细降到 VID 粒度（商品ID 不进快照，唯一VID汇总导出仍走归并表）。
  -- 同月多个文件的同一个 (站点, VID, 达人昵称, 内容类型) 在这里就合成一行，
  -- 所以后面按 (同事, 国家) 去重时天然是「合并后集合」的口径。
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
    -- 归并层已折美元，这里只留一个展示用的币种标记：单一币种显示原币种，混合显示 MIXED
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
    0, 0   -- 去重计数不在这里算（见 attribution_run_distinct，口径是「只按同事+国家」）
  FROM public.attribution_run_rows x
  WHERE x.run_id = _run_id
  GROUP BY x.bucket, x.staff, x.role, x.match_type, x.country, x.currency, x.has_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_apply_run(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_apply_run(uuid, text) TO service_role;

-- ---------- 3. 去重计数：只按 (同事, 国家) ----------

-- 三个粒度一次算完：
--   CELL  = (同事, 角色, 国家)  —— 表格格子，用户要的口径
--   STAFF = (同事, 角色)        —— 合计列（跨站点再去重一次，不是把格子相加）
--   TOTAL = 整月               —— 顶部卡片
-- 统计范围是 bucket='STAFF' 的行，即真正归到人的部分；每个粒度各自 count(DISTINCT)，互不相加。
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

-- ---------- 4. 内容类型占比（商品卡 / 直播 / 视频 / 其他） ----------

-- 所有行都入库、只是分类不同：商品卡与「其他」不归人，但 GMV 照样存着，
-- 需要看「整个国家的 GMV 各自占多少」时查这个。
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
