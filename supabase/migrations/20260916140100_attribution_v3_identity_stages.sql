-- GMV 归因 V3 阶段 2（2/2）：身份三层表 + 达人新素材归属区间表。
-- 见 GMV_ATTRIBUTION_V3_PLAN §三「身份层设计」、§五「数据分层与表设计」。
--
-- 【本迁移不改变任何归因数字】：表建好、由 attribution-identity-build 全量生成，
-- 但归因引擎尚未读取它们（「只生成不使用」），用来先回答「改完会变多少」。
--
-- 分层（§3.2 的重要修正，不是全都可重建）：
--   · creator_identity_edges     事实层，append-only，人工只能把边标 REJECTED，不能删
--   · creator_entities           半持久层，creator_id 一经分配永不重新随机生成
--   · creator_identity_aliases   派生层，每次从边重算
--   · creator_attribution_stages 派生层，可整表删重建

-- ---------------------------------------------------------------------------
-- 1. creator_identity_edges — 身份证据边（「这些名字属于同一个达人」的原始证据）
--    站点进所有唯一约束：§6.5 已确认跨站点同 VID 是正常现象（PH/PH2 同国两个店、
--    MX 三个店），身份按站点隔离，不合并、不报冲突、不产生待判项。
-- ---------------------------------------------------------------------------
CREATE TABLE public.creator_identity_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site text NOT NULL,
  vid text NOT NULL,
  feishu_nickname_norm text NOT NULL DEFAULT '',
  feishu_username_norm text NOT NULL DEFAULT '',
  gmv_nickname_norm text NOT NULL DEFAULT '',
  -- §3.3：GMV MAX 侧的观察日期 = 文件月份的**下一个月 1 日**（月结后导出那一刻的昵称）。
  -- 【只用于别名新鲜度排序】，不得进入 posted_site_date / 归属转移日 / VID 发布日的任何计算。
  observed_date date,
  last_observed_date date,
  source text NOT NULL CHECK (source IN ('FEISHU','GMV_MAX','MANUAL')),
  -- REJECTED = 人工否决错误合并。union-find 的合并本身不可逆，这是唯一的逃生口（§3.2）。
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REJECTED')),
  evidence jsonb,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site, vid, source, feishu_nickname_norm, feishu_username_norm, gmv_nickname_norm)
);
GRANT ALL ON public.creator_identity_edges TO service_role;
ALTER TABLE public.creator_identity_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_identity_edges FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_identity_edges_touch BEFORE UPDATE ON public.creator_identity_edges
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX creator_identity_edges_site_vid_idx ON public.creator_identity_edges(site, vid);
CREATE INDEX creator_identity_edges_active_idx ON public.creator_identity_edges(site) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 2. creator_entities — creator_id 分配表（半持久）
--    人工判定、「都不算」规则将来会引用 creator_id，所以这个 ID 必须稳定：
--    只增不重建；两个实体被合并时保留创建更早的一方，另一方记 merged_into。
--    identity_signature = 该实体当前连通分量的确定性签名（分量内最小 name_norm），
--    重算后靠它找回「同一个分量」并复用原 creator_id，而不是重新随机分配。
-- ---------------------------------------------------------------------------
CREATE TABLE public.creator_entities (
  creator_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site text NOT NULL,
  identity_signature text NOT NULL,
  merged_into uuid REFERENCES public.creator_entities(creator_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site, identity_signature)
);
GRANT ALL ON public.creator_entities TO service_role;
ALTER TABLE public.creator_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_entities FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_entities_touch BEFORE UPDATE ON public.creator_entities
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX creator_entities_alive_idx ON public.creator_entities(site) WHERE merged_into IS NULL;

-- ---------------------------------------------------------------------------
-- 3. creator_identity_aliases — 达人历史昵称/用户名（派生层，每次从边重算）
--    §3.6 字段级最新值：current_nickname / current_username 各自独立取「日期最新的非空值」，
--    空值不得覆盖非空值 —— 所以历史值全部保留在这张表里，不删不改，
--    查询时按 identity_type 分组、按 last_seen_date 降序取第一条。
--    UNIQUE (site, identity_type, normalized_value)：一个名字在一个站点只能属于一个实体。
-- ---------------------------------------------------------------------------
CREATE TABLE public.creator_identity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES public.creator_entities(creator_id) ON DELETE CASCADE,
  site text NOT NULL,
  identity_type text NOT NULL CHECK (identity_type IN ('NICKNAME','USERNAME')),
  identity_value text NOT NULL DEFAULT '',
  normalized_value text NOT NULL,
  first_seen_date date,
  last_seen_date date,
  source text NOT NULL CHECK (source IN ('FEISHU','GMV_MAX','MANUAL')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site, identity_type, normalized_value)
);
GRANT ALL ON public.creator_identity_aliases TO service_role;
ALTER TABLE public.creator_identity_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_identity_aliases FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_identity_aliases_touch BEFORE UPDATE ON public.creator_identity_aliases
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX creator_identity_aliases_creator_idx ON public.creator_identity_aliases(creator_id);

-- ---------------------------------------------------------------------------
-- 4. creator_attribution_stages — 达人「新素材」归属区间（派生层）
--    §2 命名：叫「归属区间」而不是 creator_ownership_stages，避免被读成「历史 GMV 整体转移」。
--    区间半开 [start_date, end_date)，end_date IS NULL = 至今。
--    §九：区间不得重叠，UNIQUE(start_date) 不够 → daterange + EXCLUDE USING gist。
--    区间内部的事件生成优先级：正式交接 > 同日人工达人判定 > 90 天规则自动切换。
-- ---------------------------------------------------------------------------
CREATE TABLE public.creator_attribution_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL,
  creator_key text NOT NULL,
  creator_id uuid REFERENCES public.creator_entities(creator_id) ON DELETE SET NULL,
  staff_name text NOT NULL,
  -- 这一段归属是怎么来的（按上面的优先级取名）
  stage_type text NOT NULL CHECK (stage_type IN ('FIRST_CONTACT','HANDOVER','MANUAL','AUTO_90D')),
  start_date date NOT NULL,
  end_date date,
  evidence jsonb,
  built_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  valid_range daterange GENERATED ALWAYS AS (daterange(start_date, end_date, '[)')) STORED,
  CHECK (end_date IS NULL OR end_date > start_date)
);
ALTER TABLE public.creator_attribution_stages
  ADD CONSTRAINT stages_no_overlap
  EXCLUDE USING gist (country WITH =, creator_key WITH =, valid_range WITH &&);
GRANT ALL ON public.creator_attribution_stages TO service_role;
ALTER TABLE public.creator_attribution_stages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_attribution_stages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_attribution_stages_touch BEFORE UPDATE ON public.creator_attribution_stages
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX creator_attribution_stages_lookup_idx ON public.creator_attribution_stages(country, creator_key);
CREATE INDEX creator_attribution_stages_staff_idx ON public.creator_attribution_stages(staff_name);

-- ---------------------------------------------------------------------------
-- 5. 区间对账视图：新区间表的「最后一段」 vs 现有单值归属 creator_ownership
--    阶段 2 的验收靠它：差异行就是「90 天转移未分段」影响到的历史数据，
--    先让人看到影响面，阶段 3.6 引擎切换时这些行的 GMV 会真的改判。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.creator_stage_ownership_diff AS
WITH last_stage AS (
  SELECT DISTINCT ON (country, creator_key)
    country, creator_key, staff_name, stage_type, start_date, end_date
  FROM public.creator_attribution_stages
  ORDER BY country, creator_key, start_date DESC
)
SELECT
  COALESCE(s.country, o.country)        AS country,
  COALESCE(s.creator_key, o.match_key)  AS creator_key,
  o.display_name,
  o.owner_bd                            AS current_owner_bd,
  s.staff_name                          AS stage_owner_bd,
  s.stage_type,
  s.start_date                          AS stage_start_date,
  o.transfer_count,
  CASE
    WHEN o.match_key IS NULL THEN 'ONLY_IN_STAGES'
    WHEN s.creator_key IS NULL THEN 'ONLY_IN_OWNERSHIP'
    WHEN s.staff_name IS DISTINCT FROM o.owner_bd THEN 'OWNER_DIFFERS'
    ELSE 'SAME'
  END AS diff_kind
FROM last_stage s
FULL OUTER JOIN (
  SELECT country, match_key, display_name, owner_bd, transfer_count
  FROM public.creator_ownership
  WHERE key_type = 'NICKNAME'
) o ON o.country = s.country AND o.match_key = s.creator_key;
GRANT SELECT ON public.creator_stage_ownership_diff TO service_role;

-- ---------------------------------------------------------------------------
-- 6. attribution_identity_gmv_names — 身份边的 GMV MAX 侧输入
--    GMV MAX 导出行只有昵称、没有用户名，但有 VID —— 这是两边唯一能对上的锚点。
--    走 RPC 去重后再出库：ad_upload_agg 是行级明细，整表拉进 Edge Function 会直接吃掉内存与 CPU 配额。
--    只取 READY 的上传批次，与归因快照的口径一致。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attribution_identity_gmv_names(
  _months integer DEFAULT 6,
  _country text DEFAULT NULL
)
RETURNS TABLE (country text, vid text, account_name text, month text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT a.country, a.vid, btrim(a.account_name), a.month
  FROM public.ad_upload_agg a
  JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
  WHERE a.vid <> ''
    AND btrim(a.account_name) <> ''
    AND (_country IS NULL OR a.country = _country)
    AND a.month >= to_char(date_trunc('month', now()) - make_interval(months => greatest(_months, 0)), 'YYYY-MM');
$$;
REVOKE ALL ON FUNCTION public.attribution_identity_gmv_names(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_identity_gmv_names(integer, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. attribution_posted_at_gap — 阶段 0 第 1 项：历史数据缺「发布时间」的影响面
--    §7.5：posted_at 改必填后，已上传的缺列历史数据在新引擎下会进 PENDING。
--    占比低（<5%）就让它们进 PENDING 人工处理；占比高就重新导出历史文件覆盖上传。
--    做成视图而不是一次性 SQL：阶段 3.1 上线前后都要看，反复粘 SQL 不如直接 select。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.attribution_posted_at_gap AS
SELECT
  a.month,
  a.country,
  count(*) FILTER (WHERE a.posted_at IS NULL)                                   AS missing_rows,
  count(*)                                                                      AS total_rows,
  round(100.0 * sum(a.gmv_usd) FILTER (WHERE a.posted_at IS NULL)
        / nullif(sum(a.gmv_usd), 0), 2)                                         AS missing_gmv_pct,
  round(sum(a.gmv_usd) FILTER (WHERE a.posted_at IS NULL)::numeric, 2)          AS missing_gmv_usd,
  round(sum(a.gmv_usd)::numeric, 2)                                             AS total_gmv_usd
FROM public.ad_upload_agg a
JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
GROUP BY a.month, a.country;
GRANT SELECT ON public.attribution_posted_at_gap TO service_role;
