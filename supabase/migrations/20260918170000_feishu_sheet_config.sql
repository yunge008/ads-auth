-- 飞书表名配置：把「代码读写哪个飞书表格的哪个 sheet、哪些列」从硬编码搬到数据库。
--
-- 起因（C1）：`attribution-feishu` 里原来有一张 SHEET_ALIASES 兜底表，飞书那边表名改了
-- 就靠别名去猜。猜对一次的代价是：真改名时静默读到另一张表，或者读空还以为「本期没数据」。
-- 现在改成配置表 —— 表名变了去设置页改一行，不用改代码、不用重新部署，
-- 顺带也回答了「系统到底动了飞书哪些表、哪些列、会不会写回去」这个每次都要翻代码才知道的问题。
--
-- 匹配规则：只按 sheet_name **精确匹配**（去掉首尾/中间空白后比较），不做任何别名猜测。
-- 找不到就报错并列出该表格里现有的 sheet 名，让人去设置页改。

CREATE TABLE public.feishu_sheet_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 代码里引用这张配置的稳定标识，改表名不影响它
  config_key text NOT NULL UNIQUE,
  -- 飞书表格（文件）名称，纯展示用，让人知道去哪个文件里找
  spreadsheet_label text NOT NULL,
  -- 表格 token 来自哪个 secret：空 = 主表格 FEISHU_SPREADSHEET_TOKEN
  spreadsheet_env text NOT NULL DEFAULT '',
  -- sheet 名称，**可改**，代码按它精确匹配
  sheet_name text NOT NULL,
  -- 读取范围（如 'A2:Z' / 'M3:S'），空 = 由代码决定
  read_range text NOT NULL DEFAULT '',
  -- READ = 只读；READWRITE = 会回写飞书。看这一列就知道改坏了会不会污染飞书原始数据
  access text NOT NULL DEFAULT 'READ' CHECK (access IN ('READ', 'READWRITE')),
  -- 这张表用来做什么、对应哪段业务逻辑
  note text NOT NULL DEFAULT '',
  -- 列映射：[{ "col": "B", "field": "发样日期", "note": "发样动作日" }, ...]
  -- 前端「映射」按钮点开看的就是它
  column_map jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.feishu_sheet_config TO service_role;
ALTER TABLE public.feishu_sheet_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.feishu_sheet_config FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER feishu_sheet_config_touch BEFORE UPDATE ON public.feishu_sheet_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 初始数据 = 代码里现在硬编码的那一套，逐列抄进来。
-- 列映射的字段名与解析代码里的变量一一对应，改列位时对着这张表改即可。
-- ---------------------------------------------------------------------------
INSERT INTO public.feishu_sheet_config
  (config_key, spreadsheet_label, spreadsheet_env, sheet_name, read_range, access, note, column_map, sort_order) VALUES
('JIANLIAN', '达人建联主表格', '', '建联-{同事姓名}', 'A2:Z', 'READ',
 '各 BD 一个 sheet，sheet 名取自「人员表」的 sheet_name 列（含离职）。达人登记的主来源：昵称/用户名/VID/发样日/登记日都从这里读。',
 '[{"col":"B","field":"sample_date","note":"发样日期 → 发样动作日"},
   {"col":"C","field":"country","note":"地区·店铺 → 站点，必须英文简写（PH/TH/VN/MX-AR…），填汉字永远匹配不上"},
   {"col":"D","field":"handle","note":"用户名 → 用户名匹配键"},
   {"col":"E","field":"nickname","note":"昵称 → 昵称匹配键，GMV MAX 导出的「TikTok账号」对的就是它"},
   {"col":"K","field":"registered_sku","note":"SKU，仅记录"},
   {"col":"N","field":"register_date","note":"登记日期 = 回收素材日，保护期与归属转移看这一列"},
   {"col":"P","field":"vid","note":"VID → VID 强归因，此列必须设成「文本」格式，设成数字会丢精度整行作废"},
   {"col":"表头含 粉丝/fans/follower","field":"follower_count","note":"粉丝量，按表头自动找列位不写死列号，仅记录"}]'::jsonb, 10),
('ARCHIVE', '达人建联主表格', '', '授权记录', 'M3:S', 'READ',
 '历史归档登记。没有用户名、也没有发样日期，所以归档行只能靠昵称与 VID 归因。',
 '[{"col":"M","field":"staff_name","note":"BD，留空记成「原数据」"},
   {"col":"N","field":"register_date","note":"登记日期"},
   {"col":"O","field":"country","note":"国家/站点"},
   {"col":"P","field":"nickname","note":"达人名字，当昵称用"},
   {"col":"Q","field":"vid","note":"VID"},
   {"col":"S","field":"registered_sku","note":"SKU"}]'::jsonb, 20),
('EDITOR', '剪辑素材表格', 'FEISHU_EDITOR_SPREADSHEET_TOKEN', '{剪辑姓名}', 'A2:H', 'READ',
 '每个剪辑一个 sheet，sheet 名取自「人员表」。只用于 VID 强归因：B 列同事与 sheet 名不符的行、没有 VID 的行都跳过。',
 '[{"col":"B","field":"staff_name","note":"同事，必须等于 sheet 对应姓名，不等直接跳过"},
   {"col":"C","field":"register_date","note":"日期"},
   {"col":"D","field":"country","note":"国家/站点"},
   {"col":"E","field":"nickname","note":"账号，当昵称用"},
   {"col":"F","field":"registered_sku","note":"SKU"},
   {"col":"G","field":"vid","note":"VID，没有则整行跳过"}]'::jsonb, 30),
('PROGRESS', '达人建联主表格', '', '绩效统计记录', 'A:M', 'READWRITE',
 '归因进度快照回写目标。系统按月追加写入，人不需要填。',
 '[{"col":"A","field":"written_at","note":"回写时间"},
   {"col":"B","field":"month","note":"月份"},
   {"col":"C","field":"staff_or_bucket","note":"姓名 / 桶"},
   {"col":"D","field":"role","note":"角色"},
   {"col":"E","field":"gmv","note":"归因 GMV"},
   {"col":"F","field":"cost","note":"消耗"},
   {"col":"G","field":"orders","note":"订单"},
   {"col":"H","field":"target_usd","note":"目标 USD"},
   {"col":"I","field":"progress","note":"进度 %"},
   {"col":"J","field":"gmv_vid","note":"VID 匹配 GMV"},
   {"col":"K","field":"gmv_alias","note":"昵称/别名 GMV"},
   {"col":"L","field":"unmatched","note":"未归因参考"},
   {"col":"M","field":"note","note":"备注"}]'::jsonb, 40),
('REVIEWS', '达人建联主表格', '', '归因审查', 'A:L', 'READWRITE',
 '审查项双向同步：系统写 A–I，人工填 J/K（判定 BD、备注），系统读回后写 L 采纳标记。网页端「审查与回写」也能直接判。',
 '[{"col":"A","field":"review_key","note":"审查ID，回填的钥匙，改了就对不上"},
   {"col":"B","field":"review_type","note":"类型"},
   {"col":"C","field":"subject","note":"主体"},
   {"col":"D","field":"candidates","note":"候选 BD"},
   {"col":"E","field":"default_resolution","note":"默认处理"},
   {"col":"F","field":"evidence","note":"证据摘要"},
   {"col":"G","field":"first_seen","note":"首次发现"},
   {"col":"H","field":"last_seen","note":"最近发现"},
   {"col":"I","field":"status","note":"状态"},
   {"col":"J","field":"manual_bd","note":"人工判定 BD（人工填）"},
   {"col":"K","field":"manual_note","note":"人工备注（人工填）"},
   {"col":"L","field":"adopted","note":"采纳标记（系统写）"}]'::jsonb, 50),
('OWNERSHIP', '达人建联主表格', '', '归因记录', 'A:H', 'READWRITE',
 '达人归因表镜像，系统覆盖写，人不要手改（下次同步会被覆盖）。',
 '[{"col":"A","field":"key_type","note":"类型（昵称/用户名/别名）"},
   {"col":"B","field":"display_name","note":"名称"},
   {"col":"C","field":"match_key","note":"归一化键"},
   {"col":"D","field":"country","note":"国家"},
   {"col":"E","field":"owner_bd","note":"当前 BD"},
   {"col":"F","field":"owner_last_date","note":"最后登记日期"},
   {"col":"G","field":"transfer","note":"转移/证据"},
   {"col":"H","field":"handover_note","note":"交接提示"}]'::jsonb, 60),
('CONFIG', '绩效配置表格', 'FEISHU_PERF_SPREADSHEET_TOKEN', '绩效配置表', 'A:L', 'READ',
 '人工维护、系统只读。左半边 A–F 是月度 GMV 目标，右半边 H–L 是站点交接。「原BD」为空/无 的行是初始分配不是交接，不入交接表。',
 '[{"col":"A","field":"month","note":"目标：月份"},
   {"col":"B","field":"staff_name","note":"目标：姓名"},
   {"col":"C","field":"role","note":"目标：角色（BD/剪辑）"},
   {"col":"D","field":"target_usd","note":"目标：目标 USD"},
   {"col":"E","field":"note","note":"目标：备注"},
   {"col":"H","field":"country","note":"交接：国家"},
   {"col":"I","field":"from_bd","note":"交接：原BD，空/无 = 初始分配，不入交接表"},
   {"col":"J","field":"to_bd","note":"交接：新BD"},
   {"col":"K","field":"handover_date","note":"交接：交接日期"},
   {"col":"L","field":"note","note":"交接：备注"}]'::jsonb, 70),
('CONNECTION_STATS', '达人建联主表格', '', '建联-{同事姓名}', 'A2:Z', 'READ',
 '「发样及素材统计」页读的也是各 BD 的建联 sheet，与 JIANLIAN 同源同列，只是聚合口径不同。',
 '[{"col":"同 JIANLIAN","field":"-","note":"列映射与 JIANLIAN 完全一致"}]'::jsonb, 80)
ON CONFLICT (config_key) DO NOTHING;
