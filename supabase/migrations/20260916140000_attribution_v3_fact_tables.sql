-- GMV 归因 V3 阶段 2（1/2）：事实层新表 + 初始数据。
-- 见 GMV_ATTRIBUTION_V3_PLAN §五「事实层」、§七「初始数据与已确认口径」。
--
-- 【本迁移不改变任何归因数字】：新表建好、初始数据导入，但归因引擎尚未读取它们，
-- 引擎切换在阶段 3 逐项进行。
--
-- 日期区间口径统一为**半开区间 [start_date, end_date)**：
-- 计划 §7.1 表格里写的「结束日期 2026-06-30」= 这里的 end_date = 2026-07-01，
-- 与下一任 BD 的 start_date 严丝合缝对上，判定时不用再处理「含/不含末日」。
-- end_date IS NULL = 至今。

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. staff_site_permissions — 同事在某站点有权限开发达人的时间区间
--    用途（阶段 3.5）：越权动作产生的历史归属转移要被撤销。
-- ---------------------------------------------------------------------------
CREATE TABLE public.staff_site_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_name text NOT NULL,
  country text NOT NULL,
  start_date date NOT NULL,
  end_date date,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  valid_range daterange GENERATED ALWAYS AS (daterange(start_date, end_date, '[)')) STORED,
  CHECK (end_date IS NULL OR end_date > start_date),
  UNIQUE (staff_name, country, start_date)
);
-- 同一人同一站点的权限区间不得重叠（两条「至今」也会被这条挡住）
ALTER TABLE public.staff_site_permissions
  ADD CONSTRAINT staff_site_permissions_no_overlap
  EXCLUDE USING gist (staff_name WITH =, country WITH =, valid_range WITH &&);
GRANT ALL ON public.staff_site_permissions TO service_role;
ALTER TABLE public.staff_site_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.staff_site_permissions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER staff_site_permissions_touch BEFORE UPDATE ON public.staff_site_permissions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX staff_site_permissions_country_idx ON public.staff_site_permissions(country);

-- ---------------------------------------------------------------------------
-- 2. site_permission_enforcement — 站点权限校验的灰度开关
--    §五：按站点独立启用日期；**启用后该站点无权限记录 = 无权限**（不是全放行）。
--    阶段 2 全部留空 = 一个站点都没启用 = 校验不生效，归因行为不变。
-- ---------------------------------------------------------------------------
CREATE TABLE public.site_permission_enforcement (
  country text PRIMARY KEY,
  enforcement_start_date date NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.site_permission_enforcement TO service_role;
ALTER TABLE public.site_permission_enforcement ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.site_permission_enforcement FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER site_permission_enforcement_touch BEFORE UPDATE ON public.site_permission_enforcement
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. attribution_exclusion_rules — 「都不算」长期规则（跨月复用，优先级最高）
--    §3.4 匹配口径：
--      · vid 非空  → **只**按 VID 文本精确匹配，其余列忽略
--      · vid 为空  → country 必填，且填了的昵称/用户名要**联合**精确命中
--    命中 → bucket=EXCLUDED：不进任何人 KPI，但金额仍留在 GMV 总额里。
-- ---------------------------------------------------------------------------
CREATE TABLE public.attribution_exclusion_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vid text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  nickname_norm text NOT NULL DEFAULT '',
  handle_norm text NOT NULL DEFAULT '',
  reason text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exclusion_rule_shape CHECK (
    vid <> '' OR (country <> '' AND (nickname_norm <> '' OR handle_norm <> ''))
  ),
  UNIQUE (vid, country, nickname_norm, handle_norm)
);
GRANT ALL ON public.attribution_exclusion_rules TO service_role;
ALTER TABLE public.attribution_exclusion_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_exclusion_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER attribution_exclusion_rules_touch BEFORE UPDATE ON public.attribution_exclusion_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX attribution_exclusion_rules_vid_idx ON public.attribution_exclusion_rules(vid) WHERE vid <> '';
CREATE INDEX attribution_exclusion_rules_name_idx ON public.attribution_exclusion_rules(country, nickname_norm, handle_norm) WHERE vid = '';

-- ---------------------------------------------------------------------------
-- 4. attribution_manual_rules — VID 级人工强归因（§四 第 2 步）
--    永久有效、可停用；优先于建联表/剪辑表的 VID 登记。
-- ---------------------------------------------------------------------------
CREATE TABLE public.attribution_manual_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vid text NOT NULL,
  staff_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('BD','EDITOR')),
  enabled boolean NOT NULL DEFAULT true,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vid)
);
GRANT ALL ON public.attribution_manual_rules TO service_role;
ALTER TABLE public.attribution_manual_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_manual_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER attribution_manual_rules_touch BEFORE UPDATE ON public.attribution_manual_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. attribution_manual_decisions — 人工达人判定「事实」
--    §七的分层要点：判定事实与派生区间分离。这张表只记「人判了什么」，
--    creator_attribution_stages 由它 + 登记动作 + 交接一起重算，可整表删重建，
--    重建不会抹掉人工判定（这正是 v2.1 用 is_manual=true 特殊保护的那个坑的根因）。
--    §八：人工判定是「建立一个阶段」，不是永久豁免 —— 后续交接/合格动作可以终止它。
-- ---------------------------------------------------------------------------
CREATE TABLE public.attribution_manual_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL,
  creator_key text NOT NULL,
  -- ASSIGN = 这个达人从 effective_from 起归 staff_name；EXCLUDE = 这个达人不算任何人
  decision text NOT NULL CHECK (decision IN ('ASSIGN','EXCLUDE')),
  staff_name text,
  effective_from date NOT NULL,
  effective_to date,
  -- CREATOR = 只作用于这个达人（默认）；SITE = 该站点全部达人（批量判定用）
  scope text NOT NULL DEFAULT 'CREATOR' CHECK (scope IN ('CREATOR','SITE')),
  enabled boolean NOT NULL DEFAULT true,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'ASSIGN' OR staff_name IS NOT NULL),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (country, creator_key, effective_from, decision)
);
GRANT ALL ON public.attribution_manual_decisions TO service_role;
ALTER TABLE public.attribution_manual_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_manual_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER attribution_manual_decisions_touch BEFORE UPDATE ON public.attribution_manual_decisions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX attribution_manual_decisions_creator_idx ON public.attribution_manual_decisions(country, creator_key);

-- ---------------------------------------------------------------------------
-- 6. site_handovers 补列（§8.1 交接范围）
--    已确认按整站点处理，不等飞书补列；scope='CREATORS' 是给将来的个案留的口子，
--    缺字段时一律按 SITE 处理，行为与现在一致。
-- ---------------------------------------------------------------------------
ALTER TABLE public.site_handovers
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'SITE' CHECK (scope IN ('SITE','CREATORS'));
ALTER TABLE public.site_handovers
  ADD COLUMN IF NOT EXISTS creator_keys text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 7. 初始数据：站点权限 14 行（§7.1）
--    结束日期已按半开区间换算（原表「2026-06-30 结束」→ end_date 2026-07-01）。
--    可重复执行：ON CONFLICT DO NOTHING，重跑不会覆盖人工后续改动。
-- ---------------------------------------------------------------------------
INSERT INTO public.staff_site_permissions (staff_name, country, start_date, end_date, note) VALUES
  ('阿木',   'PH',    DATE '2024-01-01', DATE '2026-07-01', '离职，2026-07-01 起交接给李汝华'),
  ('李汝华', 'PH',    DATE '2026-07-01', NULL,              NULL),
  ('何莎莎', 'PH',    DATE '2026-09-15', NULL,              '不是交接：PH 自 2026-09-15 起两个 BD 并存，与李汝华之间按保护期规则处理'),
  ('李汝华', 'PH2',   DATE '2026-05-01', NULL,              NULL),
  ('林丽洪', 'TH',    DATE '2024-01-01', NULL,              NULL),
  ('林丽洪', 'VN',    DATE '2024-01-01', NULL,              '起始日待确认（§八 阶段 0 第 2 项）。早期开发过 VN 达人，虽不再主动开发，保护期与 VID 归因仍算他的'),
  ('阿南',   'VN',    DATE '2026-02-01', NULL,              '同时还有 EDITOR 角色，历史剪辑数据按角色独立统计'),
  ('林乐欣', 'MX-AR', DATE '2024-01-01', NULL,              NULL),
  ('湘红',   'MX-NE', DATE '2025-11-01', DATE '2026-05-01', '2026-05-01 起交接给林乐欣'),
  ('林乐欣', 'MX-NE', DATE '2026-05-01', NULL,              NULL),
  ('林乐欣', 'MX-SJ', DATE '2026-04-01', NULL,              NULL),
  ('林乐欣', 'MY',    DATE '2026-07-01', NULL,              NULL),
  ('湘红',   'JP',    DATE '2025-06-01', NULL,              NULL),
  ('李汝华', 'US',    DATE '2024-01-01', NULL,              NULL)
ON CONFLICT (staff_name, country, start_date) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. 站点交接：只保留 §7.2 的 2 条真交接
--    原始清单里「原BD=无」的 11 行不是交接，而是「该站点从这天起有人负责」的初始分配，
--    已全部并入上面的权限表。它们留在交接表里会让引擎去找一个名叫「无」的 BD，
--    这里顺手清掉；同步函数侧也加了过滤（attribution-feishu sync-handovers），
--    否则下一次夜间同步又会把它们从飞书灌回来。
-- ---------------------------------------------------------------------------
DELETE FROM public.site_handovers
WHERE btrim(coalesce(from_bd, '')) IN ('', '无', '無', '-', 'N/A', 'NA', 'none', 'null');

INSERT INTO public.site_handovers (country, from_bd, to_bd, handover_date, note) VALUES
  ('PH',    '阿木', '李汝华', DATE '2026-07-01', '阿木离职'),
  ('MX-NE', '湘红', '林乐欣', DATE '2026-05-01', NULL)
ON CONFLICT (country, handover_date, from_bd, to_bd) DO NOTHING;
