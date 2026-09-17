-- 登记数据盘点视图：用来和飞书历史表逐行比对「有没有漏同步」。
--
-- 两张视图各回答一个问题：
--   · attribution_creator_audit —— 每个「站点 + 达人」：谁登记过、登记了几行、最早/最近动作日、当前归属
--   · attribution_vid_audit     —— 每个 VID：谁登记的、什么角色、哪张表第几行（导出后按 VID VLOOKUP 最方便）
-- 都是只读视图，不参与归因判定。

-- ---------------------------------------------------------------------------
-- 1. 达人级盘点
--    以 creator_registry 为准（登记原始行），LEFT JOIN 归属表：
--    归属列为空 = 这个达人登记了但没生成归属，通常是同步中断或昵称被判成了别的键，要查。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.attribution_creator_audit AS
WITH reg AS (
  SELECT
    country,
    nickname_norm,
    max(nickname_raw)                                            AS nickname_raw,
    max(NULLIF(handle_raw, ''))                                  AS handle_raw,
    count(*)                                                     AS reg_rows,
    count(*) FILTER (WHERE vid <> '')                            AS vid_rows,
    count(DISTINCT staff_name)                                   AS staff_count,
    min(COALESCE(register_date, sample_date))                    AS first_action_date,
    max(COALESCE(register_date, sample_date))                    AS last_action_date,
    count(*) FILTER (WHERE COALESCE(register_date, sample_date) IS NULL) AS no_date_rows,
    -- 明显是占位/误填的日期（2000-01-01 这类），它们会把「首次建联日」拉到很早，抢走归属
    count(*) FILTER (WHERE COALESCE(register_date, sample_date) < DATE '2015-01-01') AS placeholder_date_rows,
    string_agg(DISTINCT staff_name, ' / ' ORDER BY staff_name)    AS registered_by,
    string_agg(DISTINCT source, ' / ' ORDER BY source)            AS sources,
    string_agg(DISTINCT source_sheet, ' / ' ORDER BY source_sheet) AS source_sheets
  FROM public.creator_registry
  WHERE role = 'BD' AND nickname_norm <> ''
  GROUP BY country, nickname_norm
)
SELECT
  r.country                        AS 站点,
  r.nickname_raw                   AS 达人昵称,
  r.handle_raw                     AS 用户名,
  r.nickname_norm                  AS 归一化昵称,
  o.owner_bd                       AS 当前归属BD,
  r.registered_by                  AS 登记过的同事,
  r.staff_count                    AS 登记人数,
  r.reg_rows                       AS 登记行数,
  r.vid_rows                       AS 带VID行数,
  r.first_action_date              AS 最早动作日,
  r.last_action_date               AS 最近动作日,
  o.transfer_count                 AS 归属转移次数,
  r.no_date_rows                   AS 无日期行数,
  r.placeholder_date_rows          AS 占位日期行数,
  r.sources                        AS 来源类型,
  r.source_sheets                  AS 来源表,
  CASE
    WHEN o.match_key IS NULL                 THEN '未生成归属'
    WHEN r.placeholder_date_rows > 0         THEN '有占位日期，首次建联日可能失真'
    WHEN r.staff_count > 1                   THEN '多人登记'
    ELSE ''
  END AS 备注
FROM reg r
LEFT JOIN public.creator_ownership o
  ON o.key_type = 'NICKNAME' AND o.country = r.country AND o.match_key = r.nickname_norm;
GRANT SELECT ON public.attribution_creator_audit TO service_role;

-- ---------------------------------------------------------------------------
-- 2. VID 级盘点
--    creator_registry（含日期、昵称、来源行号）∪ staff_vid_map（历史授权归档，无日期）。
--    同一个 VID 被多人登记时会出现多行 —— 那正是 VID_DUAL_SOURCE 冲突的原始证据。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.attribution_vid_audit AS
SELECT
  r.vid                                    AS vid,
  r.country                                AS 站点,
  r.staff_name                             AS 登记人,
  r.role                                   AS 角色,
  COALESCE(r.register_date, r.sample_date) AS 登记日期,
  r.nickname_raw                           AS 达人昵称,
  NULLIF(r.handle_raw, '')                 AS 用户名,
  r.registered_sku                         AS 登记SKU,
  r.source                                 AS 来源类型,
  r.source_sheet                           AS 来源表,
  r.row_number                             AS 表内行号
FROM public.creator_registry r
WHERE r.vid <> ''
UNION ALL
SELECT
  m.vid, m.country, m.staff_name, m.source_type, NULL::date, '', NULL, NULL,
  'VID_MAP', 'staff_vid_map', NULL
FROM public.staff_vid_map m
WHERE m.vid <> '';
GRANT SELECT ON public.attribution_vid_audit TO service_role;
