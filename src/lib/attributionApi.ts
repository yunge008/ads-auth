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

/** 明细行 = 一个归并组（VID × 达人昵称 × 商品ID × 内容类型 × 币种），rows_count 是它合并了多少条 Excel 原始行。 */
export type DetailRow = {
  vid: string;
  account_name: string;
  product_id?: string | null;
  rows_count?: number;
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
  return invokeFn<{
    registry_rows: number;
    /** 其中带有效 VID 的行数：为 0 说明 VID 强匹配这一层必然全落空 */
    registry_vid_rows?: number;
    ownership_keys: number;
    reviews_open: number;
    missing_sheets: string[];
    /** 飞书把 VID 列当数字返回、超出 2^53 丢精度而被丢弃的单元格数（读取已统一 ToString，正常应为 0） */
    vid_precision_lost?: number;
    /** 含汉字的站点写法（站点统一用英文简写，这些行永远匹配不上） */
    cjk_sites?: Array<{ site: string; rows: number }>;
  }>(
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
    invokeFn<{ row_count: number; agg_rows?: number }>(
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
  remove: (upload_id: string) => invokeFn<{ deleted: number }>("attribution-upload", { action: "delete", upload_id }),
  removeMany: (upload_ids: string[]) =>
    invokeFn<{ deleted: number }>("attribution-upload", { action: "delete", upload_ids }, { timeout: 120000 }),
  removeAll: () =>
    invokeFn<{ deleted: number }>("attribution-upload", { action: "delete", all: true }, { timeout: 120000 }),
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

/** 站点精确匹配后仍未归因、但名字在建联/别名表里登记过（登记在别的站点）的一行。 */
export type SiteMismatchRow = {
  upload_country: string;
  account_name: string;
  rows: number;
  gmv_usd: number;
  registered: Array<{ bd: string; country: string; source: string }>;
};

export function siteMismatch(month: string) {
  return invokeFn<{ month: string; rows: SiteMismatchRow[] }>(
    "attribution-upload",
    { action: "site_mismatch", month },
    { timeout: 120000 },
  );
}

// ---------- 第二层：归因结果快照 ----------

/** 一次「全站点全人员」归因快照的元数据。 */
export type RunMeta = {
  id: string;
  month: string;
  /** CRON=每晚自动刷新 · MANUAL=页面上手动重算 · UPLOAD=上传完成后刷新 */
  source: string;
  triggered_by: string | null;
  status: "RUNNING" | "READY" | "FAILED";
  upload_count: number;
  agg_rows: number;
  raw_rows: number;
  staff_count: number;
  total_gmv: number;
  total_cost: number;
  total_orders: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export const snapshotApi = {
  /** 读该月最新快照（秒开）。run=null 表示该月还没跑过快照。 */
  report: (month: string) =>
    invokeFn<{ run: RunMeta | null; summary: AttributionReport | null }>(
      "attribution-upload",
      { action: "report", month },
      { timeout: 60000 },
    ),
  /** 重新计算并生成一条新快照（会比较慢，页面上要给等待提示）。 */
  refresh: (month: string, source = "MANUAL") =>
    invokeFn<{
      months: string[];
      // skipped=true 表示该月没有新数据、直接沿用上一版快照（cron 才会跳过，手动重算永远强制重跑）
      results: Array<{ month: string; ok: boolean; skipped?: boolean; reason?: string; run?: RunMeta; error?: string }>;
    }>("attribution-upload", { action: "refresh", month, source }, { timeout: 600000 }),
  /** 从快照明细表下钻，不重算。 */
  detail: (p: { run_id?: string; month?: string; detail_for: DrillFilter }) =>
    invokeFn<{ detail_rows: DetailRow[]; run_id?: string }>(
      "attribution-upload",
      { action: "report_detail", ...p },
      { timeout: 120000 },
    ),
  /** 快照历史。 */
  runs: (month?: string, limit = 20) =>
    invokeFn<{ runs: RunMeta[] }>("attribution-upload", { action: "runs", month, limit }, { timeout: 60000 }),
};

/** 归因口径自查（attribution-upload → action=diagnose）。 */
export type DiagnoseLayer = {
  /** Excel 原始行数（按归并组的 rows_count 还原） */
  rows: number;
  /** 归并后的组数 */
  agg_rows: number;
  product_card: number;
  vid_rows: number;
  vid_hit: number;
  no_name: number;
  name_hit_same_site: number;
  name_hit_other_site: number;
  name_never_registered: number;
  other_site_samples: Array<{ account_name: string; registered_sites: string[] }>;
};

export type DiagnoseResult = {
  month: string;
  context: {
    vid_count: number;
    ownership_keys: number;
    manual_alias: number;
    vid_alias: number;
    handover_countries: number;
    review_overrides: number;
  };
  upload_countries: string[];
  registry_countries: Array<{ country: string; keys: number }>;
  vid_countries: Array<{ country: string; rows: number }>;
  uploads: Array<{ file_name: string; country: string; status: string } & DiagnoseLayer>;
  totals: DiagnoseLayer;
  /** 本次自查顺带补跑归并的批次数（解耦改造之前上传、没有归并数据的历史批次） */
  healed?: number;
  hints: string[];
};

export function diagnoseAttribution(month: string) {
  return invokeFn<DiagnoseResult>("attribution-upload", { action: "diagnose", month }, { timeout: 300000 });
}

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

