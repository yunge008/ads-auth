// 飞书 sheet 名解析的纯函数测试。
// 跑法：deno test supabase/functions/_shared/sheetConfig.test.ts
//
// 钉死两件事：①配置读不到（表还没建、查询报错）时退回默认名而不是让同步整个挂掉；
// ②匹配只归一空白、绝不做别名猜测 —— 「绩效统计」不能匹配到「绩效统计记录」，
// 猜对一次的代价是真改名时静默读到另一张表，比直接报错难查得多。
import {
  configuredSheetName,
  isSheetEnabled,
  loadSheetConfig,
  makeOptionalResolver,
  makeSheetResolver,
  normTitle,
} from "./sheetConfig.ts";

function eq<T>(a: T, b: T, m?: string) {
  if (a !== b) throw new Error(`${m ?? ""} 实际 ${JSON.stringify(a)} ≠ 预期 ${JSON.stringify(b)}`);
}
const fakeDb = (data: unknown, error: { message: string } | null = null) => ({
  from: (_t: string) => ({ select: (_c: string) => Promise.resolve({ data, error }) }),
});

Deno.test("loadSheetConfig: 正常读取", async () => {
  const m = await loadSheetConfig(fakeDb([{ config_key: "ARCHIVE", spreadsheet_label: "主表", sheet_name: "授权记录", enabled: true }]));
  eq(m.size, 1);
  eq(m.get("ARCHIVE")!.sheet_name, "授权记录");
});

Deno.test("loadSheetConfig: 表不存在/报错 → 空 Map，调用方退回默认名而不是全挂", async () => {
  eq((await loadSheetConfig(fakeDb(null, { message: "relation does not exist" }))).size, 0);
  eq((await loadSheetConfig({ from: () => { throw new Error("boom"); } })).size, 0);
});

Deno.test("configuredSheetName: 配了就用配的", async () => {
  const m = await loadSheetConfig(fakeDb([{ config_key: "REVIEWS", spreadsheet_label: "", sheet_name: "归因审查2", enabled: true }]));
  eq(configuredSheetName(m, "REVIEWS", "归因审查"), "归因审查2");
});

Deno.test("configuredSheetName: 没配 / 留空 / 已停用 → 退回默认名", async () => {
  const m = await loadSheetConfig(fakeDb([
    { config_key: "A", spreadsheet_label: "", sheet_name: "   ", enabled: true },
    { config_key: "B", spreadsheet_label: "", sheet_name: "改过的名", enabled: false },
  ]));
  eq(configuredSheetName(m, "A", "默认"), "默认", "留空");
  eq(configuredSheetName(m, "B", "默认"), "默认", "停用");
  eq(configuredSheetName(m, "NOPE", "默认"), "默认", "没这行");
});

Deno.test("isSheetEnabled: 没这行视为启用（migration 没跑时保持原行为）", async () => {
  const m = await loadSheetConfig(fakeDb([{ config_key: "X", spreadsheet_label: "", sheet_name: "x", enabled: false }]));
  eq(isSheetEnabled(m, "X"), false);
  eq(isSheetEnabled(m, "NOPE"), true);
});

Deno.test("normTitle: 只去空白，不做别名", () => {
  eq(normTitle(" 归因 审查　"), "归因审查");
  eq(normTitle("绩效统计记录"), "绩效统计记录");
});

const sheets = [{ sheet_id: "s1", title: "归因审查" }, { sheet_id: "s2", title: " 绩效统计记录 " }];

Deno.test("makeSheetResolver: 空白差异能匹配，别名不能", () => {
  const r = makeSheetResolver(sheets, "飞书主表格");
  eq(r("归因审查"), "s1");
  eq(r(" 归因 审查 "), "s1");
  eq(r("绩效统计记录"), "s2");
  let msg = "";
  try { r("绩效统计"); } catch (e) { msg = (e as Error).message; }
  if (!msg.includes("没有 sheet")) throw new Error("应当抛错，实际：" + msg);
  if (!msg.includes("归因审查")) throw new Error("报错要列出现有 sheet，实际：" + msg);
  if (!msg.includes("设置")) throw new Error("报错要指路设置页，实际：" + msg);
});

Deno.test("makeOptionalResolver: 找不到返回 null 不抛错", () => {
  const r = makeOptionalResolver(sheets);
  eq(r("归因审查"), "s1");
  eq(r("建联-张三"), null);
});
