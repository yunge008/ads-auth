-- 「唯一VID汇总」导出的两处修正。
--
-- 1) 达人昵称取错了「最多」的定义。
--    原 JS 口径是「把同一个 (站点,VID,商品ID) 下每种昵称写法的行数**加起来**，取行数最多的写法」；
--    我搬进 SQL 时写成了 (array_agg(account_name ORDER BY rows_count DESC))[1]，
--    那是「取单条归并行行数最大的那条的昵称」——归并行是按 (批次, 内容类型, 币种) 拆开的，
--    同一个昵称会散在多条里，加起来才是它真正的行数。写法不同的昵称只在少数达人上出现，
--    但这张表是拿去和本地 Excel 逐行对账的，口径不能有「差不多」。
--    修法：先把本页这 2 万组对应的 (…,昵称) 行数汇总出来，再 DISTINCT ON 取最大。
--    join 在分页后的 g 上，所以代价跟着页大小走，不会因为整月体量变大。
--
-- 2) 顺带说明：总行数（attribution_vid_summary_count）不再由导出流程调用。
--    它只是给进度条显示分母用的，却要整月扫一遍 GROUP BY，被放在第一页请求里
--    等于给第一次请求平白加上一次全月聚合，反而更容易超时。
--    导出的完整性不依赖它——翻页只在「本页行数 < 页大小」时结束，中途任何一页出错都会抛，
--    所以循环正常结束就意味着取全了。函数保留，需要时可单独查。

CREATE OR REPLACE FUNCTION public.attribution_vid_summary_json(
  _month text,
  _run_id uuid DEFAULT NULL,
  _limit integer DEFAULT 20000,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '180s'
AS $$
  WITH g AS (
    SELECT
      a.country,
      a.vid,
      a.product_id,
      sum(a.gmv_usd)             AS gmv,
      sum(a.cost_usd)            AS cost,
      sum(a.orders)::bigint      AS orders,
      sum(a.impressions)::bigint AS pv,
      sum(a.clicks)::bigint      AS clicks
    FROM public.ad_upload_agg a
    JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
    WHERE a.month = _month
    GROUP BY a.country, a.vid, a.product_id
    ORDER BY a.country, a.vid, a.product_id
    LIMIT _limit OFFSET _offset
  ),
  -- 本页各组里，每种昵称写法的总行数（跨批次/内容类型/币种加总）
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
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
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
    ORDER BY g.country, g.vid, g.product_id
  ) t;
$$;

REVOKE ALL ON FUNCTION public.attribution_vid_summary_json(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_vid_summary_json(text, uuid, integer, integer) TO service_role;

-- 归并表按 (month, country, vid, product_id) 的分组查找会被反复用到，补个索引
CREATE INDEX IF NOT EXISTS ad_upload_agg_month_vid_product_idx
  ON public.ad_upload_agg(month, country, vid, product_id);
