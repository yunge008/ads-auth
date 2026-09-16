-- 保护期统一 90 自然天：口径校验 + 「缺发布时间」影响面口径修正。
--
-- 背景：2026-09-16 起归因引擎（_shared/attribution.ts 的 resolveOwnership）由「3 个自然月」
-- 改为「90 自然天」。SQL 侧本来就没有实现过保护期（只把 creator_ownership 当查找表用），
-- 所以这份迁移不改任何判定，只加两样东西：
--   1. 修正 attribution_posted_at_gap：**只有视频/图片类型才应该有「发布时间」**，
--      直播和商品卡片本身没有这个字段，把它们算进「缺失」是把正常数据当成了问题数据；
--   2. 一套独立的一致性校验：用 SQL 重算一遍保护期归属，与引擎落库的 creator_ownership 对账。

-- ---------------------------------------------------------------------------
-- 1. 哪些行「应该」有发布时间
--    ad_upload_agg.creative_type 存的是 src/lib/adExcel.ts 归一化后的值
--    （video / product_card / live / 其余保留原文，比如「图片」「Image」）。
--    这里只排除明确没有发布时间的两类，其余（视频、图片及将来可能出现的新类型）都算「应该有」。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attribution_needs_posted_at(_creative_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(btrim(coalesce(_creative_type, ''))) NOT IN
    ('product_card', 'product card', '商品卡片', '商品卡', 'live', '直播');
$$;
REVOKE ALL ON FUNCTION public.attribution_needs_posted_at(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_needs_posted_at(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. attribution_posted_at_gap 口径修正
--    分母改成「应该有发布时间的行」，另外单列出直播/商品卡的金额，
--    免得看的人以为这部分数据丢了。
--    needs_pending_gmv = 真正会在阶段 3.1 之后进 PENDING 的金额：
--      应该有发布时间 且 为空 且 没有被 VID 强归因命中（有 VID 登记的行根本不需要发布时间）。
-- ---------------------------------------------------------------------------
-- 列名和列序都变了，CREATE OR REPLACE VIEW 改不了列名，只能先删再建（没有对象依赖它）
DROP VIEW IF EXISTS public.attribution_posted_at_gap;
CREATE VIEW public.attribution_posted_at_gap AS
WITH vid_known AS (
  SELECT DISTINCT vid FROM public.creator_registry WHERE vid <> ''
  UNION
  SELECT DISTINCT vid FROM public.staff_vid_map   WHERE vid <> ''
),
rows AS (
  SELECT
    a.month,
    a.country,
    a.gmv_usd,
    a.creative_type,
    a.posted_at,
    public.attribution_needs_posted_at(a.creative_type) AS needs_posted_at,
    (a.vid <> '' AND EXISTS (SELECT 1 FROM vid_known k WHERE k.vid = a.vid)) AS vid_attributed
  FROM public.ad_upload_agg a
  JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
)
SELECT
  month,
  country,
  count(*) FILTER (WHERE needs_posted_at AND posted_at IS NULL)              AS missing_rows,
  count(*) FILTER (WHERE needs_posted_at)                                    AS need_posted_at_rows,
  count(*)                                                                   AS total_rows,
  -- 缺失占比的分母是「应该有发布时间」的金额，不是全部金额
  round(100.0 * sum(gmv_usd) FILTER (WHERE needs_posted_at AND posted_at IS NULL)
        / nullif(sum(gmv_usd) FILTER (WHERE needs_posted_at), 0), 2)         AS missing_gmv_pct,
  round(sum(gmv_usd) FILTER (WHERE needs_posted_at AND posted_at IS NULL)::numeric, 2) AS missing_gmv_usd,
  -- 真正会进 PENDING 的部分：缺发布时间且没被 VID 强归因命中
  round(sum(gmv_usd) FILTER (
          WHERE needs_posted_at AND posted_at IS NULL AND NOT vid_attributed
        )::numeric, 2)                                                       AS pending_gmv_usd,
  round(100.0 * sum(gmv_usd) FILTER (
          WHERE needs_posted_at AND posted_at IS NULL AND NOT vid_attributed
        ) / nullif(sum(gmv_usd), 0), 2)                                      AS pending_gmv_pct_of_total,
  -- 直播 / 商品卡片：本来就没有发布时间，单列出来，不算缺失
  round(sum(gmv_usd) FILTER (WHERE NOT needs_posted_at)::numeric, 2)         AS no_posted_at_by_design_usd,
  round(sum(gmv_usd)::numeric, 2)                                            AS total_gmv_usd
FROM rows
GROUP BY month, country;
GRANT SELECT ON public.attribution_posted_at_gap TO service_role;

-- ---------------------------------------------------------------------------
-- 3. 保护期一致性校验：SQL 独立重算 vs 引擎落库结果
--
-- 【这是一份「第二实现」】，故意不复用 TS 代码，用来交叉验证引擎有没有按 90 天落库。
-- 口径必须与 _shared/attribution.ts 的 resolveOwnership **逐条对齐**：
--   · 只看 BD 行的昵称键（引擎的 NICKNAME 路径）；
--   · 每行只取一个日期 `COALESCE(register_date, sample_date)`，无日期行排最前；
--     ↑ 这条是**当前引擎**的行为。V3 阶段 3.2 会把一行展开成发样/回收两个事件，
--       那一步落地时**必须同步改这个函数**，否则这份校验会开始报假差异。
--   · owner = 最早登记 BD；同 BD 再登记刷新 owner_last；
--   · 异 BD 登记距 owner_last 满 _protection_days 自然天 → 转移；未满 → 抢注无效（计入 grab_count）；
--   · owner 完全没有日期时无法主张保护期 → 异 BD 直接转移。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attribution_protection_owner_90d(
  _country text DEFAULT NULL,
  _protection_days integer DEFAULT 90
)
RETURNS TABLE (
  country text,
  match_key text,
  owner_bd text,
  first_date date,
  owner_last_date date,
  transfer_count integer,
  grab_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r            record;
  cur_key      text := NULL;
  v_country    text;
  v_match      text;
  v_owner      text;
  v_owner_last date;
  v_first      date;
  v_transfers  integer;
  v_grabs      integer;
BEGIN
  FOR r IN
    SELECT
      cr.country                                       AS c,
      cr.nickname_norm                                 AS nm,
      cr.staff_name                                    AS staff,
      COALESCE(cr.register_date, cr.sample_date)       AS d
    FROM public.creator_registry cr
    WHERE cr.role = 'BD'
      AND cr.nickname_norm <> ''
      AND cr.staff_name <> ''
      AND (_country IS NULL OR cr.country = _country)
    -- NULLS FIRST 对应引擎里「无日期行按 '0000-00-00' 排最前」
    ORDER BY cr.country, cr.nickname_norm, COALESCE(cr.register_date, cr.sample_date) ASC NULLS FIRST, cr.id
  LOOP
    IF cur_key IS DISTINCT FROM (r.c || '|' || r.nm) THEN
      IF cur_key IS NOT NULL THEN
        country := v_country; match_key := v_match; owner_bd := v_owner;
        first_date := v_first; owner_last_date := v_owner_last;
        transfer_count := v_transfers; grab_count := v_grabs;
        RETURN NEXT;
      END IF;
      cur_key := r.c || '|' || r.nm;
      v_country := r.c; v_match := r.nm;
      v_owner := r.staff; v_owner_last := r.d; v_first := r.d;
      v_transfers := 0; v_grabs := 0;
      CONTINUE;
    END IF;

    IF r.staff = v_owner THEN
      IF r.d IS NOT NULL AND (v_owner_last IS NULL OR r.d > v_owner_last) THEN
        v_owner_last := r.d;
      END IF;
    ELSIF v_owner_last IS NULL THEN
      v_owner := r.staff; v_owner_last := r.d; v_transfers := v_transfers + 1;
    ELSIF r.d IS NOT NULL AND (r.d - v_owner_last) >= _protection_days THEN
      v_owner := r.staff; v_owner_last := r.d; v_transfers := v_transfers + 1;
    ELSE
      v_grabs := v_grabs + 1;
    END IF;
  END LOOP;

  IF cur_key IS NOT NULL THEN
    country := v_country; match_key := v_match; owner_bd := v_owner;
    first_date := v_first; owner_last_date := v_owner_last;
    transfer_count := v_transfers; grab_count := v_grabs;
    RETURN NEXT;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.attribution_protection_owner_90d(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_protection_owner_90d(text, integer) TO service_role;

-- 引擎落库结果 vs SQL 重算结果。正常情况下**应该一行都查不出来**；
-- 查出行 = 要么引擎还没按 90 天重跑（去点一次「同步达人登记」），要么两边口径真的分叉了。
CREATE OR REPLACE VIEW public.attribution_protection_check_90d AS
SELECT
  COALESCE(s.country, o.country)       AS country,
  COALESCE(s.match_key, o.match_key)   AS match_key,
  o.display_name,
  o.owner_bd                           AS engine_owner_bd,
  s.owner_bd                           AS sql_owner_bd,
  o.owner_last_register_date           AS engine_owner_last_date,
  s.owner_last_date                    AS sql_owner_last_date,
  o.transfer_count                     AS engine_transfer_count,
  s.transfer_count                     AS sql_transfer_count,
  s.grab_count                         AS sql_grab_count,
  CASE
    WHEN o.match_key IS NULL                              THEN 'ONLY_IN_SQL'
    WHEN s.match_key IS NULL                              THEN 'ONLY_IN_ENGINE'
    WHEN s.owner_bd IS DISTINCT FROM o.owner_bd           THEN 'OWNER_DIFFERS'
    WHEN s.owner_last_date IS DISTINCT FROM o.owner_last_register_date THEN 'OWNER_LAST_DATE_DIFFERS'
    ELSE 'SAME'
  END AS diff_kind
FROM public.attribution_protection_owner_90d() s
FULL OUTER JOIN (
  SELECT country, match_key, display_name, owner_bd, owner_last_register_date, transfer_count
  FROM public.creator_ownership
  WHERE key_type = 'NICKNAME'
) o ON o.country = s.country AND o.match_key = s.match_key;
GRANT SELECT ON public.attribution_protection_check_90d TO service_role;
