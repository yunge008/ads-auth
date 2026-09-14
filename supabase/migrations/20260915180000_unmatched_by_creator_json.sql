-- 又一次踩到 PostgREST 的 1000 行返回上限。
--
-- `attribution_run_unmatched_by_creator` 是 RETURNS TABLE（返回行集），
-- PostgREST 单次最多回 1000 行，而 2026-08 的无建联达人有两千多个。
-- 更要命的是被截掉的是**哪一千个**：这个聚合的输出按分组键 (站点, 归一化昵称) 有序，
-- 站点字母序是 JP → MX-AR → MX-NE → MX-SJ → MY → PH → PH2 → TH → US → VN，
-- 于是前 1000 行正好被 JP 和 MX-AR 吃满，页面上的站点下拉就只剩这两个，
-- 看起来像「其它站点的无建联达人全都消失了」。
--
-- 和判定键那次一模一样的坑：**凡是可能超过 1000 行的 RPC，一律打成 JSON（单行）返回并分页**。
-- 行集版本删掉，免得以后又有人直接调它。
DROP FUNCTION IF EXISTS public.attribution_run_unmatched_by_creator(uuid);

CREATE OR REPLACE FUNCTION public.attribution_run_unmatched_by_creator_json(
  _run_id uuid, _limit integer DEFAULT 20000, _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  FROM (
    SELECT
      r.country,
      -- 同一个归一化名可能有多种原始写法，取 GMV 最大的那种做展示名
      (array_agg(r.account_name ORDER BY r.gmv_usd DESC))[1] AS account_name,
      public.attribution_norm_name(r.account_name) AS name_norm,
      sum(r.gmv_usd) AS gmv_usd,
      sum(r.rows_count)::bigint AS rows_count
    FROM public.attribution_run_rows r
    WHERE r.run_id = _run_id
      AND r.bucket = 'UNMATCHED'
      AND public.attribution_norm_name(r.account_name) <> ''
    GROUP BY r.country, public.attribution_norm_name(r.account_name)
    -- 分页要稳定就必须显式排序，否则两次请求的行序没有保证
    ORDER BY r.country, public.attribution_norm_name(r.account_name)
    LIMIT _limit OFFSET _offset
  ) t;
$$;

REVOKE ALL ON FUNCTION public.attribution_run_unmatched_by_creator_json(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_unmatched_by_creator_json(uuid, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 顺带把达人昵称的取值口径补进游标分页版的导出函数。
--
-- 正确口径是「把同一个 (站点,VID,商品ID) 下每种昵称写法的行数**加起来**，取行数最多的写法」。
-- `(array_agg(account_name ORDER BY rows_count DESC))[1]` 取的是「单条归并行行数最大的那条的昵称」——
-- 归并行按 (批次, 内容类型, 币种) 拆开，同一个昵称散在多条里，必须加总才对。
-- 这张表是拿去和本地 Excel 逐行对账的，昵称口径不能有偏差。
CREATE OR REPLACE FUNCTION public.attribution_vid_summary_page(
  _month text,
  _run_id uuid DEFAULT NULL,
  _limit integer DEFAULT 5000,
  _after_country text DEFAULT NULL,
  _after_vid text DEFAULT NULL,
  _after_product text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  WITH g AS (
    SELECT
      a.country,
      a.vid,
      a.product_id,
      sum(a.gmv_usd)              AS gmv,
      sum(a.cost_usd)             AS cost,
      sum(a.orders)::bigint       AS orders,
      sum(a.impressions)::bigint  AS pv,
      sum(a.clicks)::bigint       AS clicks
    FROM public.ad_upload_agg a
    JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
    WHERE a.month = _month
      AND (
        _after_country IS NULL
        OR (a.country, a.vid, a.product_id) > (_after_country, coalesce(_after_vid, ''), coalesce(_after_product, ''))
      )
    GROUP BY a.country, a.vid, a.product_id
    ORDER BY a.country, a.vid, a.product_id
    LIMIT _limit
  ),
  nm AS (
    SELECT a.country, a.vid, a.product_id, btrim(a.account_name) AS account_name,
           sum(a.rows_count)::bigint AS n
    FROM public.ad_upload_agg a
    JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
    JOIN g ON g.country = a.country AND g.vid = a.vid AND g.product_id = a.product_id
    WHERE a.month = _month AND btrim(a.account_name) <> ''
    GROUP BY 1, 2, 3, 4
  ),
  best_name AS (
    SELECT DISTINCT ON (nm.country, nm.vid, nm.product_id)
      nm.country, nm.vid, nm.product_id, nm.account_name
    FROM nm
    ORDER BY nm.country, nm.vid, nm.product_id, nm.n DESC, nm.account_name
  )
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.country, t.vid, t.product_id), '[]'::jsonb)
  FROM (
    SELECT
      g.country,
      _month AS month,
      g.vid,
      coalesce(b.account_name, '（无账号）')                    AS account_name,
      coalesce(o.staff, '')                                    AS staff,
      CASE o.role WHEN 'EDITOR' THEN '剪辑' WHEN 'BD' THEN 'BD' ELSE '' END AS role,
      CASE o.bucket
        WHEN 'STAFF' THEN '归到人'
        WHEN 'PRODUCT_CARD' THEN '商品卡片'
        WHEN 'OTHER' THEN '其他类型'
        WHEN 'UNMATCHED' THEN '未建联达人'
        ELSE ''
      END                                                      AS bucket,
      coalesce(o.match_type, '')                               AS match_type,
      g.product_id,
      coalesce(s.merchant_sku, '')                             AS sku,
      g.gmv, g.cost, g.orders,
      CASE WHEN g.cost > 0 THEN g.gmv / g.cost END             AS roi,
      g.pv, g.clicks,
      CASE WHEN g.pv > 0 THEN g.clicks::numeric / g.pv END     AS ctr,
      CASE WHEN g.clicks > 0 THEN g.orders::numeric / g.clicks END AS cvr
    FROM g
    LEFT JOIN best_name b
      ON b.country = g.country AND b.vid = g.vid AND b.product_id = g.product_id
    LEFT JOIN LATERAL (
      SELECT m.merchant_sku
      FROM public.sku_product_map m
      WHERE m.product_id = g.product_id AND m.country = g.country
      LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT r.staff, r.role, r.match_type, r.bucket
      FROM public.attribution_run_rows r
      WHERE _run_id IS NOT NULL
        AND r.run_id = _run_id
        AND r.country = g.country
        AND r.vid = g.vid
      GROUP BY r.staff, r.role, r.match_type, r.bucket
      ORDER BY sum(r.gmv_usd) DESC
      LIMIT 1
    ) o ON true
  ) t;
$$;

REVOKE ALL ON FUNCTION public.attribution_vid_summary_page(text, uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_vid_summary_page(text, uuid, integer, text, text, text) TO service_role;

-- 归属查找每页要做几千次，没有这个索引会退化成对 attribution_run_rows 的重复全表扫
CREATE INDEX IF NOT EXISTS attribution_run_rows_run_country_vid_idx
  ON public.attribution_run_rows(run_id, country, vid);
