// GMV 归因前端类型与 API 封装（对应 attribution-run / attribution-upload / attribution-feishu）。
import { invokeFn } from "@/lib/api";
import type { ParsedRow } from "@/lib/adExcel";

export type Role = "BD" | "EDITOR";
export type MatchType = "VID" | "ALIAS_MANUAL" | "REGISTRY" | "ALIAS_VID";
export type BucketKey = "PRODUCT_CARD" | "UNMATCHED";

export type StaffCell = { country: string; gmv: number; cost: number; orders: number; counted: boolean };
export type StaffAgg = {
  staff_name: string;
  role: Role;
  active: boolean;
  gmv: number;
  cost: number;
  orders: number;
  counted_gmv: number;
  target_usd: number | null;
  progress: number | null;
  by_match: Partial<Record<MatchType, number>>;
  by_country: StaffCell[];
};
export type BucketAgg = { gmv: number; cost: number; orders: number; rows: number };
export type AttributionReport = {
  period: { start: string; end: string };
  month?: string;
  kpi_threshold: number;
  staff: StaffAgg[];
  product_card: BucketAgg;
  unmatched: BucketAgg & { top: Array<{ account_name: string; gmv: number; rows: number }> };
  // usd_rate=null → 缺汇率、未计入任何汇总；有值 → 已折美元计入，gmv_usd 是折算结果
  non_usd: Array<{ currency: string; gmv: number; cost: number; rows: number; usd_rate: number | null; gmv_usd: number }>;
  totals: { gmv: number; cost: number; orders: number; rows: number };
};

export type DetailRow = {
  row_no?: number;
  vid: string;
  account_name: string;
  campaign_name?: string | null;
  product_id?: string | null;
  country: string;
  creative_type: string;
  gmv: number;
  cost: number;
  orders: number;
  currency: string;
  active_days?: number;
  bucket: string;
  staff: string | null;
  source: Role | null;
  match_type: MatchType | null;
  posted_at: string | null;
  posted_at_source?: string | null;
  handover_applied?: boolean;
};

export type DrillFilter = { staff?: string; role?: Role; bucket?: BucketKey };

export type ExchangeRateRec = {
  currency: string;
  usd_rate: number;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
};

export type VidSummaryRow = {
  country: string;
  month: string;
  vid: string;
  account_name: string;
  product_id: string;
  sku: string;
  gmv: number;
  cost: number;
  orders: number;
  roi: number | null;
  pv: number;
  clicks: number;
  ctr: number | null;
  cvr: number | null;
};

export type UploadRec = {
  id: string;
  file_name: string;
  country: string;
  month: string;
  uploaded_by: string | null;
  period_start: string | null;
  period_end: string | null;
  row_count: number;
  total_cost: number;
  total_revenue: number;
  status: "UPLOADING" | "READY" | "FAILED";
  attributed_at: string | null;
  note: string | null;
  created_at: string;
};

export type ReviewRec = {
  review_key: string;
  review_type: string;
  subject: string;
  detail: unknown;
  default_resolution: string | null;
  manual_bd: string | null;
  manual_note: string | null;
  status: "OPEN" | "RESOLVED";
  first_seen_at: string;
  last_seen_at: string;
};

export const MATCH_LABELS: Record<MatchType, string> = {
  VID: "VID匹配",
  REGISTRY: "建联昵称",
  ALIAS_VID: "别名推断",
  ALIAS_MANUAL: "人工判定",
};

export const REVIEW_TYPE_LABELS: Record<string, string> = {
  VID_DUAL_SOURCE: "VID双登记",
  ALIAS_VOTE_CONFLICT: "别名冲突",
  PROTECTION_GRAB: "保护期抢注",
  KEYTYPE_CONFLICT: "昵称/用户名冲突",
  HANDOVER_BOUNDARY: "交接边界提示",
};

// ---------- API ----------

export function runAttribution(month: string, view: "admin" | "user", detailFor?: DrillFilter) {
  return invokeFn<{
    report: AttributionReport;
    detail_rows?: DetailRow[];
    persisted?: { aliases: number; reviews: number };
    last_synced_at: string | null;
  }>("attribution-run", { month, view, detail_for: detailFor }, { timeout: 120000 });
}

export function syncCreators() {
  return invokeFn<{ registry_rows: number; ownership_keys: number; reviews_open: number; missing_sheets: string[] }>(
    "attribution-sync-creators",
    {},
    { timeout: 300000 },
  );
}

export function feishuAction<T = Record<string, unknown>>(action: string, extra?: Record<string, unknown>) {
  return invokeFn<T>("attribution-feishu", { action, ...(extra ?? {}) }, { timeout: 300000 });
}

export const uploadApi = {
  create: (p: { file_name: string; country: string; month: string; note?: string; force?: boolean; replace_existing?: boolean }) =>
    invokeFn<{ upload_id: string }>("attribution-upload", { action: "create", ...p }),
  append: (upload_id: string, rows: ParsedRow[]) =>
    invokeFn<{ inserted: number }>("attribution-upload", { action: "append", upload_id, rows }, { timeout: 120000 }),
  finalize: (upload_id: string) =>
    invokeFn<{ summary: AttributionReport; row_count: number }>(
      "attribution-upload",
      { action: "finalize", upload_id },
      { timeout: 300000 },
    ),
  list: (month?: string) => invokeFn<{ uploads: UploadRec[] }>("attribution-upload", { action: "list", month }),
  get: (p: { upload_id?: string; month?: string; merged?: boolean; detail_for?: DrillFilter }) =>
    invokeFn<{
      summary: AttributionReport;
      uploads?: UploadRec[];
      upload?: UploadRec;
      detail_rows?: DetailRow[];
      last_synced_at?: string | null;
    }>("attribution-upload", { action: "get", ...p }, { timeout: 120000 }),
  remove: (upload_id: string) => invokeFn<{ deleted: boolean }>("attribution-upload", { action: "delete", upload_id }),
};

export const exchangeRateApi = {
  list: () => invokeFn<{ rates: ExchangeRateRec[] }>("attribution-upload", { action: "list_exchange_rates" }),
  save: (p: { currency: string; usd_rate: number; enabled?: boolean }) =>
    invokeFn<{ rate: ExchangeRateRec }>("attribution-upload", { action: "save_exchange_rate", ...p }),
};

export const exportApi = {
  vidSummary: (month: string) =>
    invokeFn<{ rows: VidSummaryRow[] }>("attribution-upload", { action: "export_vid_summary", month }, { timeout: 120000 }),
};

export type UnmatchedTrendRow = { country: string; account_name: string; total: number; by_month: Record<string, number> };

export function unmatchedTrend(month: string) {
  return invokeFn<{ months: string[]; rows: UnmatchedTrendRow[] }>(
    "attribution-upload",
    { action: "unmatched_trend", month },
    { timeout: 120000 },
  );
}

// ---------- 格式化 ----------

export const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 0 });
export const fmtUsd2 = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// 上个月（默认查询月份：当月数据通常尚未上传归因）
export function lastMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

