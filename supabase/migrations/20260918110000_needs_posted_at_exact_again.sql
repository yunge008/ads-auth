-- 撤回上一份 migration 的包含式匹配，恢复 attribution_needs_posted_at 的**精确匹配**。
--
-- 上一份（20260918100000）是按一个错误的假设改的：当时以为 VN 2026-05 那 10,751 USD 的
-- 「缺发布时间」是直播行写法没被认出来造成的，于是把判断放宽成包含式。
-- 实际原因与内容类型无关 —— 那份统计是在文件重传**之前**跑的（`ad_uploads.created_at` 是 UTC，
-- 而导出文件名是本地时间，查询实际早于上传约 25 分钟），数字是旧批次的残影。
--
-- 内容类型是 TikTok 导出的受控取值，只有「视频 / 商品卡片 / 直播」（及英文对应）这几种固定写法。
-- 对受控取值做模糊匹配是负收益：猜中一次不存在的写法，换来的是真出现新类型时被静默归进已知类型、
-- 再也暴露不出来。认不出来的应该显式落进「其他」，让人看见。
--
-- 那份包含式 migration 已从仓库删除（没跑过就当它不存在；跑过的话本文件会把函数覆盖回精确匹配）。
-- 它里面的 attribution_creative_type_audit 诊断视图挪到本文件末尾保留 —— 那个不做任何判断，
-- 只是把库里出现过的内容类型写法列出来，正好用来发现「归一化不认识的新写法」。

CREATE OR REPLACE FUNCTION public.attribution_needs_posted_at(_creative_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- 只有直播与商品卡片天然没有「发布时间」，其余（视频、图片…）都应该有
  SELECT lower(btrim(coalesce(_creative_type, ''))) NOT IN
    ('product_card', 'product card', '商品卡片', '商品卡', 'live', '直播');
$$;
REVOKE ALL ON FUNCTION public.attribution_needs_posted_at(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_needs_posted_at(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 诊断视图：库里到底出现过哪些内容类型写法
--   is_raw_value = true → 归一化没认出来的原文，归因里会落进「其他」桶（不归人）。
--   出现新写法时应该回头补进归一化表（src/lib/adExcel.ts 的 normCreativeType 与
--   supabase/functions/_shared/attribution.ts 的 normalizeCreativeType，两边都是精确匹配，必须同步改），
--   而不是把匹配放宽。
-- ---------------------------------------------------------------------------
-- 先删再建：那份已删除的 migration 里建过同名视图但列序不同，
-- CREATE OR REPLACE VIEW 改不了列名列序，跑过的库会直接报错。
DROP VIEW IF EXISTS public.attribution_creative_type_audit;
CREATE VIEW public.attribution_creative_type_audit AS
SELECT
  a.creative_type                                     AS creative_type,
  public.attribution_needs_posted_at(a.creative_type) AS needs_posted_at,
  (a.creative_type NOT IN ('video', 'product_card', 'live')) AS is_raw_value,
  count(*)                                            AS agg_rows,
  sum(a.rows_count)                                   AS raw_rows,
  count(*) FILTER (WHERE a.posted_at IS NULL)         AS agg_rows_without_posted_at,
  round(sum(a.gmv_usd)::numeric, 2)                   AS gmv_usd
FROM public.ad_upload_agg a
JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
GROUP BY a.creative_type;
GRANT SELECT ON public.attribution_creative_type_audit TO service_role;

-- ---------------------------------------------------------------------------
-- attribution_norm_creative_type 同步收成精确匹配
--
-- 这是内容类型归一化的**第三份实现**（另两份：src/lib/adExcel.ts 的 normCreativeType、
-- supabase/functions/_shared/attribution.ts 的 normalizeCreativeType），
-- 而且这一份**参与判定** —— attribution_month_keys_ext 用它筛候选键，
-- 商品卡 / 直播 / 其他在别名投票之前就被分流走。
--
-- 原实现带三条包含式兜底（%CARD% / %LIVE% / %VIDEO%），与另外两份精确匹配的口径分叉。
-- 三份实现同一件事却口径不同，是最难查的那类 bug，这里一并收齐。
--
-- 【会不会改数字】只影响「写法不是受控取值」的行：库里若没有这类写法，改动为零影响。
-- 改之前可以先查：SELECT * FROM public.attribution_creative_type_audit WHERE is_raw_value;
-- 有行的话，那些行会从 video/live/product_card 落回 'other'（不归人，但金额仍在总额里）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attribution_norm_creative_type(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN s = '' THEN 'other'
    WHEN lower(s) IN ('视频', 'video') THEN 'video'
    WHEN lower(s) IN ('商品卡片', 'product card', 'product_card', '商品卡') THEN 'product_card'
    WHEN lower(s) IN ('直播', 'live') THEN 'live'
    ELSE 'other'
  END
  FROM (SELECT btrim(coalesce(_raw, '')) AS s) x;
$$;
