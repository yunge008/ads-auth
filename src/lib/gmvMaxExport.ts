// GMV Max 按时间段导出（前端驱动 gmv-max-raw-export 的 json 分片模式）。
// 循环带 cursor 调用直到 next_cursor 为空，再在本地生成 xlsx / csv，并与 campaign 级汇总对账。
import * as XLSX from "xlsx";
import { invokeFn } from "@/lib/api";

type Cursor = { campaign_ids: string[]; window_index: number };
type CampaignTotal = { campaign_id: string; cost: number; gross_revenue: number; orders: number };
type Chunk = {
  rows: Record<string, unknown>[];
  next_cursor: Cursor | null;
  campaigns_total?: number;
  campaigns_remaining: number;
  campaign_totals?: CampaignTotal[];
  errors: string[];
};

export type ReconcileRow = {
  campaign_id: string;
  campaign_name: string;
  total_cost: number;
  detail_cost: number;
  total_gmv: number;
  detail_gmv: number;
};

export type GmvMaxExportResult = {
  rows: Record<string, unknown>[];
  errors: string[];
  /** 明细合计与 campaign 汇总差额超过 0.01 的 campaign；空数组 = 全部对上 */
  mismatches: ReconcileRow[];
  /** 首片 campaign 汇总查询失败时为 false，此时无法对账 */
  reconciled: boolean;
  calls: number;
};

const ID_COLUMNS = new Set(["advertiser_id", "campaign_id", "item_group_id", "item_id"]);
const PREFERRED = ["advertiser_id", "advertiser_name", "country", "campaign_id", "campaign_name", "campaign_operation_status", "item_group_id", "item_id", "stat_time_day"];

export async function fetchGmvMaxRange(
  params: { advertiser_id: string; start_date: string; end_date: string },
  onProgress?: (p: { done: number; total: number; rows: number }) => void,
): Promise<GmvMaxExportResult> {
  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let totals: CampaignTotal[] | undefined;
  let total = 0;
  let cursor: Cursor | null = null;
  let calls = 0;
  let lastKey = "";
  do {
    const chunk: Chunk = await invokeFn<Chunk>("gmv-max-raw-export", { ...params, format: "json", cursor }, { timeout: 150000 });
    calls++;
    rows.push(...chunk.rows);
    errors.push(...chunk.errors);
    if (calls === 1) {
      totals = chunk.campaign_totals;
      total = chunk.campaigns_total ?? 0;
    }
    cursor = chunk.next_cursor;
    // 保险：服务端若没推进 cursor 就停止，避免死循环
    const key = JSON.stringify(cursor);
    if (cursor && key === lastKey) throw new Error("导出分片没有推进，已停止；请缩小日期范围后重试");
    lastKey = key;
    onProgress?.({ done: total - chunk.campaigns_remaining, total, rows: rows.length });
  } while (cursor);

  const nameById = new Map<string, string>();
  const detail = new Map<string, { cost: number; gmv: number }>();
  for (const r of rows) {
    const id = String(r.campaign_id ?? "");
    nameById.set(id, String(r.campaign_name ?? ""));
    const d = detail.get(id) ?? { cost: 0, gmv: 0 };
    d.cost += Number(r.cost ?? 0) || 0;
    d.gmv += Number(r.gross_revenue ?? 0) || 0;
    detail.set(id, d);
  }
  const mismatches: ReconcileRow[] = [];
  for (const t of totals ?? []) {
    const d = detail.get(t.campaign_id) ?? { cost: 0, gmv: 0 };
    if (Math.abs(d.cost - t.cost) > 0.01 || Math.abs(d.gmv - t.gross_revenue) > 0.01) {
      mismatches.push({
        campaign_id: t.campaign_id, campaign_name: nameById.get(t.campaign_id) ?? "",
        total_cost: t.cost, detail_cost: d.cost, total_gmv: t.gross_revenue, detail_gmv: d.gmv,
      });
    }
  }
  return { rows, errors, mismatches, reconciled: !!totals, calls };
}

export function orderColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  return [...PREFERRED.filter((k) => keys.has(k)), ...[...keys].filter((k) => !PREFERRED.includes(k)).sort()];
}

function cellValue(key: string, v: unknown): string | number {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  // ID 列一律文本：19 位 VID 转成数字会被 Excel 截成科学计数法、末位变 0
  if (ID_COLUMNS.has(key)) return s;
  return /^-?\d{1,15}(\.\d+)?$/.test(s) ? Number(s) : s;
}

export function downloadGmvMaxXlsx(rows: Record<string, unknown>[], fileName: string, mismatches: ReconcileRow[] = []) {
  const headers = orderColumns(rows);
  const aoa = [headers, ...rows.map((r) => headers.map((k) => cellValue(k, r[k])))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "GMV Max");
  if (mismatches.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mismatches.map((m) => ({
      campaign_id: m.campaign_id, campaign_name: m.campaign_name,
      "汇总消耗": m.total_cost, "明细消耗合计": m.detail_cost, "汇总GMV": m.total_gmv, "明细GMV合计": m.detail_gmv,
    }))), "对账差异");
  }
  XLSX.writeFile(wb, fileName);
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = /^[=+\-@]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function downloadGmvMaxCsv(rows: Record<string, unknown>[], fileName: string) {
  const headers = orderColumns(rows);
  const csv = `﻿${headers.join(",")}\r\n${rows.map((r) => headers.map((k) => csvCell(r[k])).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
