-- 【第 3 步 / 共 3 步】聚合只加 USD、去重计数只按 (同事,国家)、内容类型占比。

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
