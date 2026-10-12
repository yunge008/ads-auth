// GMV Max 按时间段导出（gmv-max-raw-export）的离线测试，用假的 TikTok 接口跑，不发真实请求。
// 跑法：deno test supabase/functions/_shared/gmv-max-export.test.ts
//
// 钉死几件事：①带 stat_time_day 的报表按 30 天切窗（TikTok 超 30 天会报错）；
// ②分片续跑拼起来和一次跑完结果完全一致、不重不漏；③campaign/get 没列出的 campaign（如已删除）也会导出；
// ④明细合计能和 campaign 级汇总对上；⑤单元失败记进 errors，不影响其它 campaign。
import {
  buildCsv, csvCell, type ExportChunk, type ExportCursor, runExportChunk, splitWindows, validDate,
} from "./gmv-max-export.ts";
import type { ttGet } from "./tiktok.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg ? msg + "：" : ""}实际 ${JSON.stringify(actual)} ≠ 预期 ${JSON.stringify(expected)}`);
  }
}
async function assertRejects(fn: () => Promise<unknown>, includes: string) {
  try {
    await fn();
  } catch (e) {
    if (!(e as Error).message.includes(includes)) throw new Error(`错误信息不含「${includes}」：${(e as Error).message}`);
    return;
  }
  throw new Error("预期抛错但没有");
}

const START = "2026-07-01";
const END = "2026-08-30"; // 61 天 → 3 个窗口
function datesBetween(s: string, e: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${s}T00:00:00Z`); d.toISOString().slice(0, 10) <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// 数据集：c1 (2 组 × 共 20 条素材 × 61 天，>1000 行触发翻页)，c2 (1 组 1 素材)，c3 已删除不在 campaign/get 里
type Fact = { campaign_id: string; item_group_id: string; item_id: string; day: string; cost: number; rev: number };
const FACTS: Fact[] = [];
for (const day of datesBetween(START, END)) {
  for (let i = 0; i < 20; i++) FACTS.push({ campaign_id: "c1", item_group_id: i < 10 ? "g1" : "g2", item_id: `7${String(i).padStart(18, "0")}`, day, cost: 1, rev: 3 });
  FACTS.push({ campaign_id: "c2", item_group_id: "g3", item_id: "7999999999999999999", day, cost: 2, rev: 5 });
  if (day <= "2026-07-10") FACTS.push({ campaign_id: "c3", item_group_id: "g4", item_id: "7888888888888888888", day, cost: 0.5, rev: 1 });
}

function makeApi(opts: { clock?: { t: number }; msPerCall?: number; failCampaign?: string } = {}) {
  let calls = 0;
  const get = (async (_token: string, path: string, params: Record<string, string>, _r?: number, _w?: unknown, ensureTime?: () => void) => {
    ensureTime?.();
    calls++;
    if (opts.clock) opts.clock.t += opts.msPerCall ?? 0;
    if (path === "/gmv_max/campaign/get/") {
      return { list: [{ campaign_id: "c1", campaign_name: "活动一", operation_status: "ENABLE" }, { campaign_id: "c2", campaign_name: "活动二", operation_status: "DISABLE" }], page_info: { total_page: 1 } };
    }
    const dims = JSON.parse(params.dimensions) as string[];
    const filter = JSON.parse(params.filtering) as { campaign_ids?: string[]; item_group_ids?: string[] };
    const days = datesBetween(params.start_date, params.end_date).length;
    if (dims.includes("stat_time_day") && days > 30) throw new Error("/gmv_max/report/get/: date range exceeds 30 days");
    if (opts.failCampaign && filter.campaign_ids?.includes(opts.failCampaign)) throw new Error("/gmv_max/report/get/: boom");
    const facts = FACTS.filter((f) => f.day >= params.start_date && f.day <= params.end_date &&
      (!filter.campaign_ids || filter.campaign_ids.includes(f.campaign_id)) &&
      (!filter.item_group_ids || filter.item_group_ids.includes(f.item_group_id)));
    const groups = new Map<string, { dimensions: Record<string, string>; metrics: Record<string, string> }>();
    for (const f of facts) {
      const d: Record<string, string> = {};
      for (const k of dims) d[k] = k === "stat_time_day" ? `${f.day} 00:00:00` : (f as unknown as Record<string, string>)[k];
      const key = JSON.stringify(d);
      const g = groups.get(key) ?? { dimensions: d, metrics: { cost: "0", gross_revenue: "0", orders: "0" } };
      g.metrics.cost = String(Number(g.metrics.cost) + f.cost);
      g.metrics.gross_revenue = String(Number(g.metrics.gross_revenue) + f.rev);
      groups.set(key, g);
    }
    const all = [...groups.values()];
    const page = Number(params.page), size = Number(params.page_size);
    return { list: all.slice((page - 1) * size, page * size), page_info: { total_page: Math.max(1, Math.ceil(all.length / size)), total_number: all.length } };
  }) as unknown as typeof ttGet;
  return { get, calls: () => calls };
}

const base = { token: "t", advertiserId: "123", advertiserName: "测试户", country: "TH", storeId: "s1", startDate: START, endDate: END };
const rowKey = (r: Record<string, unknown>) => `${r.campaign_id}|${r.item_group_id}|${r.item_id}|${r.stat_time_day}`;

async function exportAll(api: ReturnType<typeof makeApi>, clock: { t: number }, budgetMs: number) {
  const chunks: ExportChunk[] = [];
  let cursor: ExportCursor | null = null;
  do {
    const startedAt = clock.t;
    const result: ExportChunk = await runExportChunk({ ...base, cursor, get: api.get, now: () => clock.t, softDeadline: startedAt + budgetMs, hardDeadline: startedAt + budgetMs * 10 });
    chunks.push(result);
    cursor = result.next_cursor;
    if (chunks.length > 500) throw new Error("分片死循环");
  } while (cursor);
  return chunks;
}

Deno.test("日期：按 30 天切窗、非法日期被拒", () => {
  assertEquals(splitWindows(START, END), [["2026-07-01", "2026-07-30"], ["2026-07-31", "2026-08-29"], ["2026-08-30", "2026-08-30"]]);
  assertEquals(splitWindows("2026-07-01", "2026-07-01"), [["2026-07-01", "2026-07-01"]]);
  assertEquals(validDate("2026-02-30"), false, "2 月 30 日不存在");
  assertEquals(validDate("2026-02-28"), true);
});

Deno.test("一次跑完：不漏已删除 campaign、明细合计与 campaign 汇总一致", async () => {
  const clock = { t: 0 };
  const [only] = await exportAll(makeApi(), clock, 1e12);
  assertEquals(only.next_cursor, null);
  assertEquals(only.errors, []);
  assertEquals(only.campaigns_total, 3);
  assertEquals(only.rows.length, FACTS.length, "行数等于事实表");
  assertEquals(new Set(only.rows.map(rowKey)).size, FACTS.length, "无重复行");
  const c3 = only.rows.find((r) => r.campaign_id === "c3")!;
  assertEquals(c3.campaign_operation_status, "NOT_LISTED");
  assertEquals(only.rows.find((r) => r.campaign_id === "c1")!.campaign_name, "活动一");
  for (const t of only.campaign_totals!) {
    const sum = only.rows.filter((r) => r.campaign_id === t.campaign_id).reduce((s, r) => s + Number(r.cost), 0);
    assertEquals(Math.round(sum * 100), Math.round(t.cost * 100), `campaign ${t.campaign_id} 消耗对账`);
  }
});

Deno.test("分片续跑：拼接结果与一次跑完完全一致", async () => {
  const clock = { t: 0 };
  const chunks = await exportAll(makeApi({ clock, msPerCall: 1000 }), clock, 1500);
  if (chunks.length < 3) throw new Error(`预期多次分片，实际 ${chunks.length} 次`);
  const rows = chunks.flatMap((c) => c.rows);
  assertEquals(rows.length, FACTS.length, "分片后总行数");
  assertEquals(new Set(rows.map(rowKey)).size, FACTS.length, "分片间不重复");
  assertEquals(chunks[0].campaigns_total, 3);
  assertEquals(chunks.slice(1).every((c) => c.campaign_totals === undefined && c.campaigns_total === undefined), true, "汇总只在首片返回");
});

Deno.test("单元内超硬时限：首个单元都跑不完时给出可操作的报错", async () => {
  const clock = { t: 0 };
  const api = makeApi({ clock, msPerCall: 1000 });
  await assertRejects(() => runExportChunk({ ...base, cursor: { campaign_ids: ["c1"], window_index: 0 }, get: api.get, now: () => clock.t, softDeadline: 0, hardDeadline: 1500 }), "请缩小日期范围");
});

Deno.test("单个 campaign 失败只记 errors，其它照常导出", async () => {
  const clock = { t: 0 };
  const [only] = await exportAll(makeApi({ failCampaign: "c2" }), clock, 1e12);
  assertEquals(only.errors.length, 3, "c2 三个窗口各一条错误");
  assertEquals(only.rows.some((r) => r.campaign_id === "c2"), false);
  assertEquals(only.rows.filter((r) => r.campaign_id === "c1").length, FACTS.filter((f) => f.campaign_id === "c1").length);
});

Deno.test("CSV：负数不被当公式、公式注入加前缀、ID 原样", () => {
  assertEquals(csvCell("-1.5"), "-1.5");
  assertEquals(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assertEquals(csvCell('a,"b"'), '"a,""b"""');
  const csv = buildCsv([{ item_id: "7000000000000000001", campaign_id: "c1", cost: "1" }]);
  assertEquals(csv, "﻿campaign_id,item_id,cost\r\nc1,7000000000000000001,1");
});
