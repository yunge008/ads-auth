// 飞书 sheet 名的唯一解析入口：配置表 `feishu_sheet_config` + **精确匹配**。
//
// 为什么集中到一个文件：以前每个函数各写一遍 `sheets.find(s => s.title === name)`，
// 于是「飞书改了表名」这件事在不同函数里表现完全不同 —— 有的报「未找到 sheet」，
// 有的静默读空当作「本期没数据」，有的靠别名表猜到另一张表上去。
// 三种表现里最贵的是后两种：没有任何报错，数字照常出，错得看不出来。
// 现在统一成一个行为：对不上就抛错，并把该表格现有的 sheet 名全列出来，直接告诉人去哪儿改。
//
// 与配置表的分工：
//   · 固定名字的 sheet（授权记录 / 绩效配置表 / 归因审查 …）→ 名字由配置表给，改名改配置即可。
//   · 每人一张的 sheet（建联-{同事姓名} / {剪辑姓名}）→ 名字由「人员表」staff_sheets 给，
//     配置表里存的是带占位符的模板，只为说明「这类 sheet 长什么样、读哪些列」，不参与匹配。
//   · 读取列范围写死在各函数里（配置表只读展示）：改列范围必须同时改解析代码。

/** 配置表里一行的可用部分。read_range / column_map 只给人看，解析逻辑不读它们。 */
export type SheetConfigRow = {
  config_key: string;
  spreadsheet_label: string;
  sheet_name: string;
  enabled: boolean;
};

/**
 * db 的最小形状。这里刻意用 any：supabase-js 的 `.select()` 返回的是 PostgrestFilterBuilder
 * （只实现 PromiseLike，不是 Promise），想写准确的结构类型就得把 supabase 的泛型搬进 _shared，
 * 为了一次 select 不值得。真正的类型安全在下面 —— 取回来的 data 会显式断言成 SheetConfigRow[]，
 * 而且整个调用包在 try/catch 里，形状不对也只是退回默认名，不会把同步搞挂。
 */
// deno-lint-ignore no-explicit-any
type DbLike = { from: (t: string) => any };

/**
 * 读配置表。读失败或表还不存在时返回空 Map —— 各调用方都会退回代码里的默认名，
 * 这样「migration 还没跑」不至于让所有同步一起挂掉。
 */
export async function loadSheetConfig(db: DbLike): Promise<Map<string, SheetConfigRow>> {
  try {
    const { data, error } = await db
      .from("feishu_sheet_config")
      .select("config_key, spreadsheet_label, sheet_name, enabled");
    if (error) return new Map();
    const rows = (data ?? []) as SheetConfigRow[];
    return new Map(rows.map((r) => [r.config_key, r]));
  } catch {
    return new Map();
  }
}

/**
 * 取某个 key 配置的 sheet 名。
 * 配置里没这行、名字留空（= 这张表还没提供给系统）或该行已停用 → 退回代码里的默认名。
 */
export function configuredSheetName(
  cfg: Map<string, SheetConfigRow>,
  key: string,
  fallback: string,
): string {
  const row = cfg.get(key);
  if (!row || !row.enabled) return fallback;
  return row.sheet_name.trim() || fallback;
}

/** 该数据源是否启用。配置里没这行 → 视为启用（配置表没跑 migration 时保持原行为）。 */
export function isSheetEnabled(cfg: Map<string, SheetConfigRow>, key: string): boolean {
  const row = cfg.get(key);
  return row ? !!row.enabled : true;
}

/**
 * sheet 标题归一化：只去掉各种空白（含全角空格、不换行空格），**不做任何别名/模糊匹配**。
 * 人在飞书里改名时多打一个空格很常见，那是笔误；「归因审查」认成「绩效统计」则是猜，两码事。
 */
export function normTitle(t: string): string {
  return t.replace(/[\s 　]/g, "").trim();
}

/**
 * 针对某一个飞书表格建一个「sheet 名 → sheet_id」解析器。
 * 找不到时抛错并把该表格现有的 sheet 全列出来 —— 排查时最想知道的就是「那到底有哪些」。
 */
export function makeSheetResolver(
  sheets: Array<{ sheet_id: string; title: string }>,
  label: string,
  hint = "若飞书那边改了表名，请到「设置 → 飞书表名称」改配置，不要改代码。",
): (title: string) => string {
  const byName = new Map(sheets.map((s) => [normTitle(s.title), s.sheet_id]));
  return (title: string) => {
    const sid = byName.get(normTitle(title));
    if (sid) return sid;
    throw new Error(
      `${label}里没有 sheet「${title}」。${hint}` +
        `该表格现有的 sheet：${sheets.map((s) => s.title).join("、") || "（空）"}`,
    );
  };
}

/**
 * 每人一张的 sheet 用这个：找不到不抛错（离职同事的 sheet 可能真的被删了），
 * 返回 null 交给调用方记进 missing 列表汇报。
 */
export function makeOptionalResolver(
  sheets: Array<{ sheet_id: string; title: string }>,
): (title: string) => string | null {
  const byName = new Map(sheets.map((s) => [normTitle(s.title), s.sheet_id]));
  return (title: string) => byName.get(normTitle(title)) ?? null;
}

// ---------------------------------------------------------------------------
// 每人一张的 sheet：名称怎么定
// ---------------------------------------------------------------------------
// 规则（人员表 sheet名 那一列）：
//   · 填了值 → 就用这个值，该人单独指定，模板管不着（名字不规范的人走这条）。
//   · 留空   → 用配置表的模板生成：把模板里的 {占位符} 换成这个人的姓名。
// 这样飞书整批改名（建联-X → 建联表-X）只要改配置里一行模板，不用一个个改人员表；
// 而个别人名字特殊，照旧在人员表里单独填。
//
// BD 建联 sheet 的模板**只认 JIANLIAN 这一行**：CONNECTION_STATS 读的是同一批 sheet，
// 如果两行各有各的模板，改了一个没改另一个，两个函数就会去读不同的表，
// 而且两边都不会报错 —— 只是数字对不上，最难查的那种。

/** 配置表还没跑 migration 时的模板退路，与 20260918170000 的初始数据一致 */
export const DEFAULT_SHEET_TEMPLATES: Record<string, string> = {
  JIANLIAN: "建联-{同事姓名}",
  EDITOR: "{剪辑姓名}",
};

// 模板里的占位符：`{任意文字}`，整段换成姓名。
// 两个正则不是冗余：带 g 的那个用来 replace，检测必须用**不带 g** 的 —— 带 g 的正则
// 在 .test() 之间会记住 lastIndex，同一个字符串连着测两次会一次 true 一次 false。
const PLACEHOLDER_RE_G = /\{[^}]*\}/g;
const PLACEHOLDER_RE = /\{[^}]*\}/;

/** 这个 sheet 名是不是「模板」（含占位符）而不是真名 */
export function isSheetTemplate(name: string): boolean {
  return PLACEHOLDER_RE.test(name);
}

export type StaffSheetName = {
  /** 实际去飞书匹配的名字；空串 = 既没单独填、模板也拿不到，无法确定 */
  name: string;
  /** override = 人员表单独填的；template = 模板生成的；none = 定不出来 */
  source: "override" | "template" | "none";
};

/**
 * 算出某个同事实际要读哪张 sheet。
 * @param key    模板取自配置表的哪一行：BD 建联用 "JIANLIAN"，剪辑用 "EDITOR"
 * @param staffName  人员表里的姓名
 * @param override   人员表里填的 sheet 名（留空则用模板）
 */
export function staffSheetName(
  cfg: Map<string, SheetConfigRow>,
  key: "JIANLIAN" | "EDITOR",
  staffName: string,
  override: string,
): StaffSheetName {
  const fixed = (override ?? "").trim();
  if (fixed) return { name: fixed, source: "override" };
  const who = (staffName ?? "").trim();
  if (!who) return { name: "", source: "none" };
  const tpl = (cfg.get(key)?.sheet_name ?? "").trim() || DEFAULT_SHEET_TEMPLATES[key] || "";
  if (!tpl || !isSheetTemplate(tpl)) return { name: "", source: "none" };
  return { name: tpl.replace(PLACEHOLDER_RE_G, who), source: "template" };
}
