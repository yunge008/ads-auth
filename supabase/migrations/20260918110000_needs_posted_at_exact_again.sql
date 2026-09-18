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
-- 保留 20260918100000 里的 attribution_creative_type_audit 视图 —— 那个是纯诊断，
-- 正好用来盯「库里出现了归一化不认识的写法」。

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
