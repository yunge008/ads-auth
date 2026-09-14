CREATE INDEX IF NOT EXISTS ad_upload_agg_month_country_vid_product_idx
  ON public.ad_upload_agg(month, country, vid, product_id);

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
      sum(a.clicks)::bigint       AS clicks,
      (array_agg(a.account_name ORDER BY a.rows_count DESC NULLS LAST))[1] AS account_name
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
  )
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.country, t.vid, t.product_id), '[]'::jsonb)
  FROM (
    SELECT
      g.country,
      _month AS month,
      g.vid,
      coalesce(nullif(btrim(g.account_name), ''), '（无账号）') AS account_name,
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