// 申样审核意见：从 tts-export(kind=samples) 读一次原始数据，在浏览器里按阈值分类。
// 改阈值只重新分类，不重新调 API；同一店铺 10 分钟内的数据直接复用（避免限速）。
// 分类规则与 Edge Function tts-export 的 exportSamples 一致（服务端那份用于默认值导出）。
import * as XLSX from "xlsx";
import { invokeFn } from "@/lib/api";

export type SampleThresholds = {
  max_fulfill_reject: number; // 履约率低于此值 → 不批准
  min_fulfill_ok: number; // 履约率达到此值（且 GMV/粉丝达标）→ 推荐批准
  min_gmv_ok: number;
  min_followers_ok: number;
  max_unfulfilled_reject: number; // 本店已发样未履约次数达到此值 → 不批准
};
export const DEFAULT_SAMPLE_TH: SampleThresholds = {
  max_fulfill_reject: 30, min_fulfill_ok: 60, min_gmv_ok: 100, min_followers_ok: 5000, max_unfulfilled_reject: 2,
};
export const CACHE_MINUTES = 10;

export type SampleRaw = {
  appId: string; status: string; username: string; nickname: string; avatar: string; openId: string;
  followers: number | null; gmv: number | null; currency: string; contentCount: number | null; fulfill: number | null;
  plays: number | null; units: number | null; postRate: number | null;
  shopTotal: number; shopShipped: number; shopFulfilled: number; unfulfilled: number;
  productId: string; product: string; skuId: string; sku: string; commission: string;
  approvable: boolean | null; disReasons: string; partner: string; deadline: string;
};
export type Classified = SampleRaw & { advice: string; reasons: string };
export type SampleCreatorRow = Omit<Classified, "product" | "sku"> & { products: string[]; appIds: string[]; apps: Classified[] };

type Cell = string | number | null;
type Chunk = { columns: string[]; rows: Cell[][]; next_cursor: Record<string, unknown> | null; progress: { done: number; total: number | null }; errors: string[] };

const n = (v: Cell) => (v === null || v === "" || v === undefined ? null : Number(v));
function parse(columns: string[], rows: Cell[][]): SampleRaw[] {
  const ix = (c: string) => columns.indexOf(c);
  const g = (r: Cell[], c: string) => r[ix(c)];
  return rows.map((r) => ({
    appId: String(g(r, "申样单 ID") ?? ""), status: String(g(r, "申请状态") ?? ""), username: String(g(r, "达人用户名") ?? ""),
    nickname: String(g(r, "达人昵称") ?? ""), avatar: String(g(r, "头像") ?? ""), openId: String(g(r, "creator_open_id") ?? ""),
    followers: n(g(r, "粉丝数")), gmv: n(g(r, "达人GMV")), currency: String(g(r, "GMV币种") ?? ""), contentCount: n(g(r, "带货内容数")),
    fulfill: n(g(r, "平台履约率(%)")), plays: n(g(r, "电商视频平均播放")), units: n(g(r, "达人销量(件)")), postRate: n(g(r, "带货率(post_rate)")),
    shopTotal: Number(g(r, "本店历史申样数") ?? 0), shopShipped: Number(g(r, "本店已发样数") ?? 0), shopFulfilled: Number(g(r, "本店已履约数") ?? 0),
    unfulfilled: Number(g(r, "本店已发未履约数") ?? 0), productId: String(g(r, "商品 ID") ?? ""), product: String(g(r, "商品名称") ?? ""),
    skuId: String(g(r, "SKU ID") ?? ""), sku: String(g(r, "SKU 名称") ?? ""), commission: String(g(r, "申请佣金率") ?? ""),
    approvable: g(r, "平台可审批") === "是" ? true : g(r, "平台可审批") === "否" ? false : null,
    disReasons: String(g(r, "不可审批原因") ?? ""), partner: String(g(r, "服务商") ?? ""), deadline: String(g(r, "审核截止时间") ?? ""),
  }));
}

/** 按顺序判断，命中即停（与服务端规则一致） */
export function classifySample(r: SampleRaw, th: SampleThresholds): { advice: string; reasons: string } {
  const gmv = r.gmv ?? 0, fol = r.followers ?? 0, fp = r.fulfill;
  if (r.approvable === false) return { advice: "不批准", reasons: `平台不可审批：${r.disReasons || "未给原因"}` };
  if (r.unfulfilled >= th.max_unfulfilled_reject) return { advice: "不批准", reasons: `本店已发样未履约 ${r.unfulfilled} 次（≥${th.max_unfulfilled_reject}）` };
  if (fp !== null && fp < th.max_fulfill_reject) return { advice: "不批准", reasons: `平台履约率 ${fp}% < ${th.max_fulfill_reject}%` };
  if ((fp === null || fp >= th.min_fulfill_ok) && (gmv >= th.min_gmv_ok || fol >= th.min_followers_ok)) {
    const why = [fp === null ? "无履约率记录" : `履约率 ${fp}% ≥ ${th.min_fulfill_ok}%`, gmv >= th.min_gmv_ok ? `GMV ${gmv} ≥ ${th.min_gmv_ok}` : `粉丝 ${fol} ≥ ${th.min_followers_ok}`];
    if (r.shopFulfilled > 0) why.push(`本店已履约 ${r.shopFulfilled} 次`);
    return { advice: "推荐批准", reasons: why.join("；") };
  }
  return { advice: "待审核", reasons: `履约率 ${fp ?? "无"}%，GMV ${gmv}，粉丝 ${fol}，未达推荐线` };
}

const RANK: Record<string, number> = { "不批准": 0, "待审核": 1, "推荐批准": 2 };
/** 一行一个达人；同一达人多条申样取最保守的结论 */
export function groupByCreator(raws: SampleRaw[], th: SampleThresholds): SampleCreatorRow[] {
  const by = new Map<string, SampleCreatorRow>();
  for (const r of raws) {
    const c: Classified = { ...r, ...classifySample(r, th) };
    const key = r.openId || r.username;
    const label = `${r.product}${r.sku ? `（${r.sku}）` : ""}`;
    const cur = by.get(key);
    if (!cur) { by.set(key, { ...c, products: [label], appIds: [r.appId], apps: [c] }); continue; }
    cur.products.push(label); cur.appIds.push(r.appId); cur.apps.push(c);
    if ((RANK[c.advice] ?? 1) < (RANK[cur.advice] ?? 1)) { cur.advice = c.advice; cur.reasons = c.reasons; }
  }
  return [...by.values()].sort((a, b) => (RANK[b.advice] ?? 1) - (RANK[a.advice] ?? 1) || (b.gmv ?? 0) - (a.gmv ?? 0));
}

// 同一店铺的原始数据缓存（页面内切换 TAB 不丢）
type CacheEntry = { raws: SampleRaw[]; errors: string[]; fetchedAt: number; complete: boolean };
const cache = new Map<string, CacheEntry>();
export function cached(shopId: string): CacheEntry | undefined { return cache.get(shopId); }
export function isFresh(e?: CacheEntry): boolean { return !!e && e.complete && Date.now() - e.fetchedAt < CACHE_MINUTES * 60_000; }

/** 分片读取，每片读完回调一次（边读边显示） */
export async function fetchSamples(shopId: string, onChunk: (all: SampleRaw[], p: { done: number; total: number | null }, errors: string[]) => void): Promise<CacheEntry> {
  const entry: CacheEntry = { raws: [], errors: [], fetchedAt: Date.now(), complete: false };
  cache.set(shopId, entry);
  let cursor: Record<string, unknown> | null = null;
  let lastKey = "";
  do {
    const c: Chunk = await invokeFn<Chunk>("tts-export", { kind: "samples", shop_id: shopId, cursor }, { timeout: 150000 });
    entry.raws.push(...parse(c.columns, c.rows));
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

/** 用当前阈值把已读取的数据导出 xlsx（不调 API） */
export function downloadSampleXlsx(raws: SampleRaw[], th: SampleThresholds, region: string) {
  const head = ["审核建议", "建议理由", "申样单 ID", "申请状态", "达人用户名", "达人昵称", "粉丝数", "达人GMV", "GMV币种", "达人销量(件)", "平台履约率(%)",
    "带货率", "电商视频平均播放", "本店历史申样数", "本店已发样数", "本店已履约数", "本店已发未履约数", "商品 ID", "商品名称", "SKU ID", "SKU 名称",
    "申请佣金率", "平台可审批", "不可审批原因", "服务商", "审核截止时间", "creator_open_id"];
  const body = raws.map((r) => {
    const c = classifySample(r, th);
    return [c.advice, c.reasons, r.appId, r.status, r.username, r.nickname, r.followers ?? "", r.gmv ?? "", r.currency, r.units ?? "", r.fulfill ?? "",
      r.postRate ?? "", r.plays ?? "", r.shopTotal, r.shopShipped, r.shopFulfilled, r.unfulfilled, r.productId, r.product, r.skuId, r.sku,
      r.commission, r.approvable === null ? "" : r.approvable ? "是" : "否", r.disReasons, r.partner, r.deadline, r.openId];
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...body]), "审核建议");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["参数", "值"], ...Object.entries(th)]), "规则");
  XLSX.writeFile(wb, `${region}_申样审核建议_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
