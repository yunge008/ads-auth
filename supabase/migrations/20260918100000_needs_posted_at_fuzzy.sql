-- attribution_needs_posted_at 由精确匹配改为包含式匹配。
--
-- 起因：VN 2026-05 重传了带「发布时间」列的文件，行级确认 33,064 行里 31,089 行有发布时间，
-- 但 attribution_posted_at_gap 仍报 74.71% 缺失、10,751 USD。行数少、金额占比高 —— 典型的直播行特征。
--
-- 原实现只认「直播 / live / 商品卡片 / 商品卡 / product_card / product card」这几个**精确值**。
-- 而 src/lib/adExcel.ts 的 normCreativeType 也只在精确相等时才归一成 live / product_card，
-- 认不出来的一律保留原文入库。于是「直播带货」「LIVE 带货」「商品卡片推广」这类写法两边都漏掉：
-- 既没被归一，也没被排除，结果被当成「应该有发布时间却没有」，把正常数据算成了缺失。
--
-- 改成包含式：只要含「直播 / live」就是直播，含「商品卡 / product card / product_card / card」就是商品卡片，
-- 两者都不需要发布时间。判断口径与 _shared/attribution.ts 的 normalizeCreativeType 对齐
-- （那边也是先精确、再包含式兜底）。
--
-- 注意这个函数只影响「缺发布时间」的统计口径，不参与任何归因判定，所以改它不会动 GMV 归属。

CREATE OR REPLACE FUNCTION public.attribution_needs_posted_at(_creative_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT (
    -- 直播：直播 / live / LIVE 带货 / live streaming …
    lower(btrim(coalesce(_creative_type, ''))) LIKE '%live%'
    OR coalesce(_creative_type, '') LIKE '%直播%'
    -- 商品卡片：商品卡 / 商品卡片推广 / product card / product_card / card …
    OR coalesce(_creative_type, '') LIKE '%商品卡%'
    OR lower(btrim(coalesce(_creative_type, ''))) LIKE '%product%card%'
    OR lower(btrim(coalesce(_creative_type, ''))) LIKE '%product_card%'
    OR lower(btrim(coalesce(_creative_type, ''))) = 'card'
  );
$$;
REVOKE ALL ON FUNCTION public.attribution_needs_posted_at(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_needs_posted_at(text) TO service_role;

-- 附：查一下库里到底有多少种内容类型写法，认不出来的那些要回头补进归一化表
-- （归一化在 src/lib/adExcel.ts 的 normCreativeType 与 _shared/attribution.ts 的 normalizeCreativeType）。
CREATE OR REPLACE VIEW public.attribution_creative_type_audit AS
SELECT
  a.creative_type                                     AS creative_type,
  public.attribution_needs_posted_at(a.creative_type) AS needs_posted_at,
  count(*)                                            AS agg_rows,
  sum(a.rows_count)                                   AS raw_rows,
  count(*) FILTER (WHERE a.posted_at IS NULL)         AS agg_rows_without_posted_at,
  round(sum(a.gmv_usd)::numeric, 2)                   AS gmv_usd,
  -- 归一化没认出来的原文（既不是 video / product_card / live，也不是常见图片写法）
  (a.creative_type NOT IN ('video', 'product_card', 'live')) AS is_raw_value
FROM public.ad_upload_agg a
JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
GROUP BY a.creative_type;
GRANT SELECT ON public.attribution_creative_type_audit TO service_role;
