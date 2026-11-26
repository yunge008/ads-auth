// 「评论查看」页 → Edge Function `reviews`（docs/LISTING_REVIEWS_PLAN.md）
import { invokeFn } from "@/lib/api";

export type Stars = [number, number, number, number, number];
/** s1..s5 当天新增；i1..i5 当天记入的初始差额（只进累计，不算当天新增）*/
export type SeriesDay = { d: string; s1: number; s2: number; s3: number; s4: number; s5: number; i1: number; i2: number; i3: number; i4: number; i5: number; orders: number };
export type Series = { base: Stars; days: SeriesDay[]; products: number };
/** cov_*：评价和出单都已知的日子里的评价数 / 差评数 / 出单（留评率、订单差评率用）*/
export type TableRow = { site: string; pid: string; sku: string | null; below: boolean; base: Stars; range: Stars; rinit: Stars; orders: number; cov_n: number; cov_bad: number; cov_ord: number };
export type ReviewText = {
  review_id: string; star: number; review_at: string | null; order_id: string | null; seller_sku: string | null;
  content: string | null; content_zh: string | null; reply: string | null; reply_zh: string | null; img_count: number;
};
export type ShopStatus = {
  shop_key: string; crawl_from: string | null; crawl_until: string | null; api_until: string | null; orders_from: string | null; latest_available_date: string | null;
  bf_done: boolean; bf_idx: number;
  last_run_at: string | null; last_error: string | null; run_date: string | null; run_done: boolean; run_idx: number; run_total: number;
};
export type Upload = { shop_key: string; file_name: string; range_from: string; range_to: string; rows_total: number; rows_in_range: number; rows_text: number; products: number; status: string; uploaded_by: string | null; created_at: string };
export type Meta = { shops: ShopStatus[]; api_sites: string[]; settings: { min_reviews: number; threshold: number; updated_at: string; updated_by: string | null } | null; uploads: Upload[]; is_admin: boolean };
export type AlertItem = { site: string; pid: string; sku: string | null; avg: number; n: number; n30: number; bad30: number; alerted_at: string | null; new: boolean };
export type Reconcile = {
  shop_key: string; crawl_until: string | null;
  products: { pid: string; api: Stars; ours: Stars; diff: Stars; api_avg: number | null; our_avg: number | null }[];
};
export type SkuTable = { crawl_until: string | null; rows: { sku_id: string; spec: string | null; base: Stars; range: Stars }[] };
type Filter = { sites: string[]; from: string; to: string; q: string };

const call = <T,>(body: Record<string, unknown>, timeout = 60_000) => invokeFn<T>("reviews", body, { timeout });
export const reviewsApi = {
  meta: () => call<Meta>({ action: "meta" }),
  series: (f: Filter) => call<Series>({ action: "series", ...f }),
  table: (f: Filter) => call<{ rows: TableRow[] }>({ action: "table", ...f }),
  texts: (pid: string, from: string, to: string, stars: number[]) => call<{ rows: ReviewText[] }>({ action: "texts", product_id: pid, from, to, stars }),
  alerts: () => call<{ min_reviews: number; threshold: number; items: AlertItem[] }>({ action: "alerts" }),
  saveSettings: (min_reviews: number, threshold: number) => call<{ ok: true }>({ action: "save_settings", min_reviews, threshold }),
  uploadBegin: (b: Record<string, unknown>) => call<{ upload_id: string }>({ action: "upload_begin", ...b }),
  uploadDaily: (shop_key: string, rows: unknown[]) => call<{ rows: number }>({ action: "upload_daily", shop_key, rows }, 120_000),
  uploadSku: (shop_key: string, rows: unknown[], specs: unknown[]) => call<{ rows: number }>({ action: "upload_sku", shop_key, rows, specs }, 120_000),
  skuTable: (site: string, pid: string, from: string, to: string) => call<SkuTable>({ action: "sku_table", site, product_id: pid, from, to }),
  uploadTexts: (shop_key: string, rows: unknown[]) => call<{ rows: number }>({ action: "upload_texts", shop_key, rows }, 120_000),
  uploadEnd: (shop_key: string, upload_id: string) => call<{ crawl_from: string; crawl_until: string }>({ action: "upload_end", shop_key, upload_id }),
  reconcile: (shop_key: string, product_ids: string[]) => call<Reconcile>({ action: "reconcile", shop_key, product_ids }, 150_000),
  step: (shop_key: string) => call<{ finished: boolean; results: { shop: string; done: boolean; idx: number; total: number; calls: number; bf_done: boolean; bf_idx: number; error?: string }[] }>({ action: "step", shop_key }, 150_000),
};

export const sumS = (s: Stars) => s[0] + s[1] + s[2] + s[3] + s[4];
export const avgS = (s: Stars) => { const n = sumS(s); return n ? (s[0] + 2 * s[1] + 3 * s[2] + 4 * s[3] + 5 * s[4]) / n : null; };
export const addS = (a: Stars, b: Stars): Stars => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4]];
export const ZERO: Stars = [0, 0, 0, 0, 0];
