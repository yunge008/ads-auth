// GMV Max 按时间段导出的核心逻辑（只读，不写库）。
// 拆成「可续跑的分片」：每次调用处理若干个 (campaign × 30 天窗口) 单元，
// 时间不够就返回 next_cursor，前端带着 cursor 继续调，直到 next_cursor 为 null。
// 这样任意大的广告户、任意长（≤ MAX_EXPORT_DAYS）的时间段都能完整导出，
// 不会因为单次函数时限整单失败。
import { ttGet } from "./tiktok.ts";
import { fetchCampaigns, fetchReport, type CampaignInfo } from "./gmv-max-report.ts";

export const MAX_EXPORT_DAYS = 365;
// TikTok 报表带 stat_time_day 维度时单次最多 30 天，和 gmv-max-sync 同口径切窗。
export const WINDOW_DAYS = 30;
export const CREATIVE_DIMENSIONS = ["campaign_id", "item_group_id", "item_id", "stat_time_day"];
const TOTAL_METRICS = ["cost", "orders", "gross_revenue"];

export class ExportTimeBudgetExceeded extends Error {
  constructor() {
    super("导出接近函数时限（campaign 列表或汇总查询就已超时），请稍后重试或缩小日期范围");
    this.name = "ExportTimeBudgetExceeded";
  }
}

export type ExportCursor = { campaign_ids: string[]; window_index: number };
export type CampaignTotal = { campaign_id: string; cost: number; gross_revenue: number; orders: number };
export type ExportChunk = {
  rows: Record<string, unknown>[];
  next_cursor: ExportCursor | null;
  // 仅首个分片返回：本次导出要处理的 campaign 总数
  campaigns_total?: number;
  campaigns_remaining: number;
  windows: Array<[string, string]>;
  // 仅首个分片返回：campaign 级汇总，用于导出完成后和明细合计对账。
  campaign_totals?: CampaignTotal[];
  errors: string[];
};

export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === value;
}
export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function daysInclusive(start: string, end: string): number {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000) + 1;
}
export function splitWindows(start: string, end: string, max = WINDOW_DAYS): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cur = start;
  while (cur <= end) {
    const next = addDays(cur, max - 1);
    const stop = next < end ? next : end;
    out.push([cur, stop]);
    cur = addDays(stop, 1);
  }
  return out;
}
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const num = (v: unknown) => Number(v ?? 0) || 0;

export function validateCursor(raw: unknown): ExportCursor | null {
  if (raw == null) return null;
  const c = raw as Partial<ExportCursor>;
  if (!Array.isArray(c.campaign_ids) || !c.campaign_ids.every((id) => typeof id === "string" && id) ||
    !Number.isInteger(c.window_index) || (c.window_index as number) < 0) {
    throw new Error("cursor 格式错误：需要 {campaign_ids: string[], window_index: number}");
  }
  return { campaign_ids: c.campaign_ids, window_index: c.window_index as number };
}

/**
 * campaign 级汇总（不带 campaign 过滤）：
 * ①找出 campaign/get 没列出但时间段内有数据的 campaign（如已删除），保证不漏；
 * ②作为对账基准。
 */
async function fetchCampaignTotals(
  token: string, advertiserId: string, storeId: string, windows: Array<[string, string]>,
  get: typeof ttGet, ensureTime: () => void,
): Promise<CampaignTotal[]> {
  const byId = new Map<string, CampaignTotal>();
  for (const [s, e] of windows) {
    const rows = await fetchReport(token, advertiserId, storeId, s, e, ["campaign_id"], {}, TOTAL_METRICS, get, ensureTime);
    for (const row of rows) {
      const id = String((row.dimensions as Record<string, unknown> | undefined)?.campaign_id ?? "");
      if (!id) continue;
      const m = (row.metrics ?? {}) as Record<string, unknown>;
      const t = byId.get(id) ?? { campaign_id: id, cost: 0, gross_revenue: 0, orders: 0 };
      t.cost += num(m.cost);
      t.gross_revenue += num(m.gross_revenue);
      t.orders += num(m.orders);
      byId.set(id, t);
    }
  }
  return [...byId.values()];
}

export async function runExportChunk(opts: {
  token: string;
  advertiserId: string;
  advertiserName: string;
  country: string;
  storeId: string;
  startDate: string;
  endDate: string;
  cursor: ExportCursor | null;
  /** 超过后不再开始新的单元（已开始的单元继续跑完） */
  softDeadline: number;
  /** 超过后中断当前单元并丢弃其部分结果 */
  hardDeadline: number;
  get?: typeof ttGet;
  now?: () => number;
}): Promise<ExportChunk> {
  const get = opts.get ?? ttGet;
  const now = opts.now ?? Date.now;
  const ensureTime = () => {
    if (now() > opts.hardDeadline) throw new ExportTimeBudgetExceeded();
  };
  const { token, advertiserId, storeId, startDate, endDate } = opts;
  const windows = splitWindows(startDate, endDate);
  const errors: string[] = [];

  const campaigns = await fetchCampaigns(token, advertiserId, get, ensureTime);
  const meta = new Map<string, CampaignInfo>(campaigns.map((c) => [c.id, c]));

  let pending: string[];
  let windowIndex = 0;
  let campaignTotals: CampaignTotal[] | undefined;
  if (opts.cursor) {
    pending = opts.cursor.campaign_ids;
    windowIndex = opts.cursor.window_index;
    if (windowIndex >= windows.length) throw new Error("cursor.window_index 超出日期窗口范围");
  } else {
    const ids = new Set(campaigns.map((c) => c.id));
    try {
      campaignTotals = await fetchCampaignTotals(token, advertiserId, storeId, windows, get, ensureTime);
      for (const t of campaignTotals) ids.add(t.campaign_id);
    } catch (error) {
      if (error instanceof ExportTimeBudgetExceeded) throw error;
      errors.push(`campaign 汇总查询失败，无法补齐已删除 campaign、也无法对账：${(error as Error).message}`);
    }
    pending = [...ids].sort();
  }

  const rows: Record<string, unknown>[] = [];
  let unitsDone = 0;
  for (let ci = 0; ci < pending.length; ci++) {
    const cid = pending[ci];
    for (let wi = ci === 0 ? windowIndex : 0; wi < windows.length; wi++) {
      const cursorHere: ExportCursor = { campaign_ids: pending.slice(ci), window_index: wi };
      if (unitsDone > 0 && now() > opts.softDeadline) {
        return finish(cursorHere);
      }
      const [s, e] = windows[wi];
      const unitRows: Record<string, unknown>[] = [];
      try {
        const groups = await fetchReport(token, advertiserId, storeId, s, e, ["campaign_id", "item_group_id"],
          { campaign_ids: [cid] }, TOTAL_METRICS, get, ensureTime);
        const groupIds = [...new Set(groups.map((g) =>
          String((g.dimensions as Record<string, unknown> | undefined)?.item_group_id ?? "")).filter(Boolean))];
        for (const batch of chunk(groupIds, 100)) {
          const list = await fetchReport(token, advertiserId, storeId, s, e, CREATIVE_DIMENSIONS,
            { campaign_ids: [cid], item_group_ids: batch }, undefined, get, ensureTime);
          for (const row of list) {
            const dims = (row.dimensions ?? {}) as Record<string, unknown>;
            const mets = (row.metrics ?? {}) as Record<string, unknown>;
            const rowCid = String(dims.campaign_id ?? cid);
            unitRows.push({
              advertiser_id: advertiserId,
              advertiser_name: opts.advertiserName,
              country: opts.country,
              campaign_name: meta.get(rowCid)?.name ?? "",
              campaign_operation_status: meta.get(rowCid)?.operation_status ?? (meta.has(rowCid) ? "" : "NOT_LISTED"),
              ...dims,
              ...mets,
            });
          }
        }
      } catch (error) {
        if (error instanceof ExportTimeBudgetExceeded) {
          if (unitsDone === 0) {
            throw new Error(`campaign ${cid} 在 ${s}~${e} 的数据量过大，单次函数时限内拉不完；请缩小日期范围后重试`);
          }
          return finish(cursorHere);
        }
        errors.push(`campaign ${cid} ${s}~${e}：${(error as Error).message}`);
      }
      rows.push(...unitRows);
      unitsDone++;
    }
  }
  return finish(null);

  function finish(next: ExportCursor | null): ExportChunk {
    return {
      rows,
      next_cursor: next,
      ...(opts.cursor ? {} : { campaigns_total: pending.length }),
      campaigns_remaining: next ? next.campaign_ids.length : 0,
      windows,
      ...(campaignTotals ? { campaign_totals: campaignTotals } : {}),
      errors,
    };
  }
}

const PREFERRED_COLUMNS = ["advertiser_id", "advertiser_name", "country", "campaign_id", "campaign_name", "campaign_operation_status", "item_group_id", "item_id", "stat_time_day"];

export function orderColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
  return [...PREFERRED_COLUMNS.filter((k) => keys.has(k)), ...[...keys].filter((k) => !PREFERRED_COLUMNS.includes(k)).sort()];
}

export function csvCell(value: unknown): string {
  const raw = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // 防 CSV 公式注入；但负数（如 "-1.5"）是正常数值，不加前缀
  const safe = /^[=+\-@]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function buildCsv(rows: Record<string, unknown>[]): string {
  const headers = orderColumns(rows);
  const lines = rows.map((row) => headers.map((key) => csvCell(row[key])).join(","));
  return `﻿${headers.join(",")}\r\n${lines.join("\r\n")}`;
}
