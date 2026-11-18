// 申样审核意见：从 tts-export(kind=samples) 读一次原始数据，在浏览器里按负责人勾选的条件分类。
// 改条件只重新分类，不重新调 API；同一店铺 10 分钟内的数据直接复用（避免限速）。
//
// 判定（2026-11-17 负责人要求：多选框勾选才生效，条件之间为「且」）：
//   ① 任一勾选的「不批准条件」命中 → 不批准
//   ② 否则：勾选的「推荐条件」全部满足 → 推荐批准（一个都没勾 → 待审核）
//   ③ 其余 → 待审核
import * as XLSX from "xlsx";
import { invokeFn } from "@/lib/api";

export type Cond = { on: boolean; v: number };
export type SampleRules = {
  rejectNotApprovable: boolean; // 平台标记不可审批 → 不批准
  rejectFulfillBelow: Cond; // 平台履约率 < v% → 不批准
  rejectUnfulfilled: Cond; // 建联表发样未出素材 ≥ v 次 → 不批准
  okFulfill: Cond; // 履约率 ≥ v%
  okNoFulfillPass: boolean; // 无履约率记录视为满足「履约率」条件
  okGmvUsd: Cond; // 达人 GMV ≥ v USD
  okFollowers: Cond; // 粉丝 ≥ v
  okUnits: Cond; // 销量 ≥ v 件
};
export const DEFAULT_RULES: SampleRules = {
  rejectNotApprovable: true,
  rejectFulfillBelow: { on: true, v: 30 },
  rejectUnfulfilled: { on: true, v: 2 },
  okFulfill: { on: true, v: 60 },
  okNoFulfillPass: true,
  okGmvUsd: { on: true, v: 100 },
  okFollowers: { on: false, v: 5000 },
  okUnits: { on: false, v: 10 },
};
export const CACHE_MINUTES = 10;

export type SampleRaw = {
  appId: string; status: string; username: string; nickname: string; ttUid: string; openId: string; avatar: string;
  followers: number | null; gmvLocal: number | null; currency: string; gmvUsd: number | null; units: number | null;
  contentCount: number | null; fulfill: number | null; postRate: number | null; plays: number | null; videos30: number | null;
  regSamples: number; regVid: number; regOpen: number; regLast: string; regStaff: string; regItems: RegItem[];
  productId: string; product: string; skuId: string; sku: string; merchantSku: string; commission: string;
  approvable: boolean | null; disReasons: string; partner: string; deadline: string;
};
/** 飞书建联表的一条发样记录（悬停展示） */
export type RegItem = { d: string; sku: string; staff: string; vid: string; post: string; st: string };
/** 每个指标对当前条件的判定：pass 满足（绿）/ fail 不满足或命中不批准（红）/ none 未勾选相关条件 */
export type Mark = "pass" | "fail" | "none";
export type Marks = { approvable: Mark; fulfill: Mark; unfulfilled: Mark; gmv: Mark; followers: Mark; units: Mark };
export type Classified = SampleRaw & { advice: string; reasons: string; marks: Marks };
export type SampleCreatorRow = Classified & { skus: string[]; appIds: string[]; apps: Classified[] };

type Cell = string | number | null;
type Chunk = {
  columns: string[]; rows: Cell[][]; next_cursor: Record<string, unknown> | null; progress: { done: number; total: number | null }; errors: string[];
  meta?: { missing_currencies?: string[] };
};

function parseItems(raw: string): RegItem[] {
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
const n = (v: Cell) => (v === null || v === "" || v === undefined ? null : Number(v));
function parse(columns: string[], rows: Cell[][]): SampleRaw[] {
  const ix = new Map(columns.map((c, i) => [c, i]));
  return rows.map((r) => {
    const g = (c: string) => r[ix.get(c) ?? -1] ?? null;
    const s = (c: string) => String(g(c) ?? "");
    return {
      appId: s("申样单 ID"), status: s("申请状态"), username: s("达人用户名"), nickname: s("达人昵称"), ttUid: s("TikTok用户ID"),
      openId: s("creator_open_id"), avatar: s("头像"), followers: n(g("粉丝数")), gmvLocal: n(g("达人GMV(本币)") ?? g("达人GMV")), currency: s("GMV币种"),
      gmvUsd: n(g("达人GMV(USD)")), units: n(g("达人销量(件)")), contentCount: n(g("带货内容数")), fulfill: n(g("平台履约率(%)")),
      postRate: n(g("带货率(post_rate)")), plays: n(g("电商视频平均播放")), videos30: n(g("近30天发视频数(中位)")),
      regSamples: Number(g("建联表发样次数") ?? 0), regVid: Number(g("建联表有VID次数") ?? 0), regOpen: Number(g("建联表未出素材次数") ?? 0),
      regLast: s("最近发样日"), regStaff: s("建联同事"), regItems: parseItems(s("建联表明细")), productId: s("商品 ID"), product: s("商品名称"), skuId: s("SKU ID"),
      sku: s("SKU 名称"), merchantSku: s("商家SKU"), commission: s("申请佣金率"),
      approvable: g("平台可审批") === "是" ? true : g("平台可审批") === "否" ? false : null,
      disReasons: s("不可审批原因"), partner: s("服务商"), deadline: s("审核截止时间"),
    };
  });
}

export function classifySample(r: SampleRaw, k: SampleRules): { advice: string; reasons: string; marks: Marks } {
  const marks: Marks = { approvable: "none", fulfill: "none", unfulfilled: "none", gmv: "none", followers: "none", units: "none" };
  const rejects: string[] = [];
  if (k.rejectNotApprovable) {
    marks.approvable = r.approvable === false ? "fail" : "pass";
    if (r.approvable === false) rejects.push(`平台不可审批（${r.disReasons || "未给原因"}）`);
  }
  if (k.rejectUnfulfilled.on) {
    marks.unfulfilled = r.regOpen >= k.rejectUnfulfilled.v ? "fail" : "pass";
    if (marks.unfulfilled === "fail") rejects.push(`发样未出素材 ${r.regOpen} 次 ≥ ${k.rejectUnfulfilled.v}`);
  }
  if (k.rejectFulfillBelow.on && r.fulfill !== null && r.fulfill < k.rejectFulfillBelow.v) {
    marks.fulfill = "fail";
    rejects.push(`履约率 ${r.fulfill}% < ${k.rejectFulfillBelow.v}%`);
  }
  if (rejects.length) return { advice: "不批准", reasons: rejects.join("；"), marks };

  const fails: string[] = [], passes: string[] = [];
  const check = (on: boolean, ok: boolean, key: keyof Marks, okText: string, failText: string) => {
    if (!on) return;
    marks[key] = ok ? "pass" : "fail";
    (ok ? passes : fails).push(ok ? okText : failText);
  };
  const fulfillOk = r.fulfill === null ? k.okNoFulfillPass : r.fulfill >= k.okFulfill.v;
  check(k.okFulfill.on, fulfillOk, "fulfill", r.fulfill === null ? "无履约率记录（视为满足）" : `履约率 ${r.fulfill}% ≥ ${k.okFulfill.v}%`,
    r.fulfill === null ? "无履约率记录" : `履约率 ${r.fulfill}% < ${k.okFulfill.v}%`);
  check(k.okGmvUsd.on, (r.gmvUsd ?? -1) >= k.okGmvUsd.v, "gmv", `GMV $${r.gmvUsd} ≥ $${k.okGmvUsd.v}`,
    r.gmvUsd === null ? "GMV 无数据或缺汇率" : `GMV $${r.gmvUsd} < $${k.okGmvUsd.v}`);
  check(k.okFollowers.on, (r.followers ?? -1) >= k.okFollowers.v, "followers", `粉丝 ${r.followers} ≥ ${k.okFollowers.v}`, `粉丝 ${r.followers ?? "无"} < ${k.okFollowers.v}`);
  check(k.okUnits.on, (r.units ?? -1) >= k.okUnits.v, "units", `销量 ${r.units} ≥ ${k.okUnits.v}`, `销量 ${r.units ?? "无"} < ${k.okUnits.v}`);
  if (!passes.length && !fails.length) return { advice: "待审核", reasons: "未勾选推荐条件", marks };
  if (!fails.length) return { advice: "推荐批准", reasons: passes.join("；"), marks };
  return { advice: "待审核", reasons: `不满足：${fails.join("；")}`, marks };
}

const RANK: Record<string, number> = { "不批准": 0, "待审核": 1, "推荐批准": 2 };
/** 一行一个达人；同一达人多条申样取最保守的结论 */
export function groupByCreator(raws: SampleRaw[], k: SampleRules): SampleCreatorRow[] {
  const by = new Map<string, SampleCreatorRow>();
  for (const r of raws) {
    const c: Classified = { ...r, ...classifySample(r, k) };
    const key = r.openId || r.username;
    const label = r.merchantSku || r.sku || r.skuId;
    const cur = by.get(key);
    if (!cur) { by.set(key, { ...c, skus: [label], appIds: [r.appId], apps: [c] }); continue; }
    if (!cur.skus.includes(label)) cur.skus.push(label);
    cur.appIds.push(r.appId); cur.apps.push(c);
    if ((RANK[c.advice] ?? 1) < (RANK[cur.advice] ?? 1)) { cur.advice = c.advice; cur.reasons = c.reasons; cur.marks = c.marks; }
  }
  return [...by.values()].sort((a, b) => (RANK[b.advice] ?? 1) - (RANK[a.advice] ?? 1) || (b.gmvUsd ?? 0) - (a.gmvUsd ?? 0));
}

// 同一店铺的原始数据缓存（页面内切换 TAB 不丢）
type CacheEntry = {
  raws: SampleRaw[]; errors: string[]; fetchedAt: number; complete: boolean;
  /** 诊断：后台未部署新版（没有 USD 列）/ 汇率设置缺少的币种 */
  staleBackend: boolean; missingCurrencies: string[];
};
const cache = new Map<string, CacheEntry>();
export function cached(shopId: string): CacheEntry | undefined { return cache.get(shopId); }
export function isFresh(e?: CacheEntry): boolean { return !!e && e.complete && Date.now() - e.fetchedAt < CACHE_MINUTES * 60_000; }

/** 分片读取，每片读完回调一次（边读边显示） */
export async function fetchSamples(shopId: string, onChunk: (all: SampleRaw[], p: { done: number; total: number | null }, errors: string[]) => void): Promise<CacheEntry> {
  const entry: CacheEntry = { raws: [], errors: [], fetchedAt: Date.now(), complete: false, staleBackend: false, missingCurrencies: [] };
  cache.set(shopId, entry);
  let cursor: Record<string, unknown> | null = null;
  let lastKey = "";
  do {
    const c: Chunk = await invokeFn<Chunk>("tts-export", { kind: "samples", shop_id: shopId, cursor }, { timeout: 150000 });
    entry.raws.push(...parse(c.columns, c.rows));
    if (!c.columns.includes("达人GMV(USD)")) entry.staleBackend = true;
    for (const m of c.meta?.missing_currencies ?? []) if (!entry.missingCurrencies.includes(m)) entry.missingCurrencies.push(m);
    entry.errors.push(...c.errors);
    onChunk(entry.raws, c.progress, entry.errors);
    cursor = c.next_cursor;
    const key = JSON.stringify(cursor);
    if (cursor && key === lastKey) throw new Error("分片没有推进，已停止");
    lastKey = key;
  } while (cursor);
  entry.complete = true;
  entry.fetchedAt = Date.now();
  return entry;
}

/** 用当前条件把已读取的数据导出 xlsx（不调 API） */
export function downloadSampleXlsx(raws: SampleRaw[], k: SampleRules, region: string) {
  const head = ["审核建议", "建议理由", "申样单 ID", "申请状态", "达人用户名", "达人昵称", "TikTok用户ID", "粉丝数", "达人GMV(USD)", "达人GMV(本币)", "币种",
    "达人销量(件)", "平台履约率(%)", "带货率", "电商视频平均播放", "建联表发样次数", "建联表有VID次数", "建联表未出素材次数", "最近发样日", "建联同事",
    "商家SKU", "SKU 名称", "SKU ID", "商品 ID", "商品名称", "申请佣金率", "平台可审批", "不可审批原因", "服务商", "审核截止时间", "creator_open_id"];
  const body = raws.map((r) => {
    const c = classifySample(r, k);
    return [c.advice, c.reasons, r.appId, r.status, r.username, r.nickname, r.ttUid, r.followers ?? "", r.gmvUsd ?? "", r.gmvLocal ?? "", r.currency,
      r.units ?? "", r.fulfill ?? "", r.postRate ?? "", r.plays ?? "", r.regSamples, r.regVid, r.regOpen, r.regLast, r.regStaff,
      r.merchantSku, r.sku, r.skuId, r.productId, r.product, r.commission, r.approvable === null ? "" : r.approvable ? "是" : "否",
      r.disReasons, r.partner, r.deadline, r.openId];
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...body]), "审核建议");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["条件", "值"], ...Object.entries(k).map(([a, b]) => [a, JSON.stringify(b)])]), "规则");
  XLSX.writeFile(wb, `${region}_申样审核建议_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
