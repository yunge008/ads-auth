// SEA 库存监控前端调用，全部走 Edge Function `sea-inventory`（tab 权限 sea-inventory）。
import { invokeFn } from "@/lib/api";

export type WhLink = { shop_id: string; tts_warehouse_id: string };
export type SeaWarehouse = {
  code: string; name: string; provider: string; kind: "overseas" | "cn";
  status: "active" | "onboarding" | "phasing_out" | "disabled"; region: string | null; links: WhLink[];
  provider_ref: string | null; note: string | null; stock_synced_at: string | null; stock_source: string | null;
  stock_rows: number | null; stock_error: string | null;
  file_config: FileConfig | null; stock_file_name: string | null;
  /** 当前库存表汇总：SKU 数、有货 SKU 数、可用件数 */
  stock_totals?: { skus: number; in_stock: number; units: number };
};
/** 只用 warehouse_value：导出文件「仓库」列里本仓的名称，上传时按它取本仓的行 */
export type FileConfig = { warehouse_value?: string };
export type SeaSettings = {
  window_days: number; min_days: number; min_qty: number; reserve_per_sku: number; zero_sale_qty: number;
  cn_min_days: number; cn_target_days: number; stock_max_age_hours: number; target_days: number; last_run_at: string | null; map_refreshed_at: string | null;
};
export type SeaShop = { shop_id: string; shop_name: string | null; region: string | null; seller_type: string | null; access_expires_at: string | null };
export type ShopSync = { shop_id: string; listings_at: string | null; orders_at: string | null; orders_count: number | null; slots_count: number | null; error: string | null; sales_synced_day: string | null };
export type PlanRow = {
  id: string; created_at: string; source: string; status: string; executed_at: string | null; executed_by: string | null;
  summary: Record<string, unknown> | null; data_warnings?: string[] | null; map_diff?: { counts?: Record<string, number> } | null;
};
export type PlanItem = {
  id: number; kind: "overseas" | "cn"; warehouse_code: string; wh_sku: string; shop_id: string; region: string | null;
  product_id: string; sku_id: string; seller_sku: string | null; title: string | null; tts_warehouse_id: string;
  current_qty: number; proposed_qty: number; daily_sales: number; days_before: number | null; days_after: number | null;
  wh_available: number | null; pool: number | null; reason: string | null; warnings: string[]; new_link: boolean;
  selected: boolean; final_qty: number | null; live_qty: number | null; exec_qty: number | null;
  exec_status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; exec_message: string | null;
};
export type Overview = {
  settings: SeaSettings; warehouses: SeaWarehouse[]; shops: SeaShop[]; shop_sync: ShopSync[]; plans: PlanRow[];
  map_active: number; linked_shops: string[]; exec_enabled: boolean;
};
export type MapRow = {
  shop_id: string; sku_id: string; product_id: string; seller_sku: string; wh_sku: string; wh_sku_override: string | null;
  prev_seller_sku: string | null; active: boolean; changed_at: string | null; first_seen_at: string;
  slots: Array<{ tts_warehouse_id: string; qty: number; sold: number; title: string | null }>;
};
export type StockRow = { wh_sku: string; available: number; on_hand: number | null; product_name: string | null; source: string; fetched_at: string };

const fn = <T,>(action: string, body: Record<string, unknown> = {}, timeout = 150_000) =>
  invokeFn<T>("sea-inventory", { action, ...body }, { timeout });

export const seaApi = {
  overview: () => fn<Overview>("overview"),
  saveSettings: (s: Partial<SeaSettings>) => fn<{ ok: true }>("save_settings", s),
  saveWarehouse: (w: Partial<SeaWarehouse> & { code: string }) => fn<{ ok: true }>("save_warehouse", w),
  shopWarehouses: (shop_id: string) => fn<{ fallback?: boolean; error?: string; warehouses: Array<{ id: string; name?: string; type?: string; sub_type?: string; is_default?: boolean; effect_status?: string; address?: { region_code?: string } }> }>("shop_warehouses", { shop_id }),
  importStock: (warehouse_code: string, rows: Array<{ wh_sku: string; available: number; on_hand?: number | null; product_name?: string | null }>, opts: { as_of?: string | null; file_name?: string } = {}) =>
    fn<{ ok: true; rows: number; total_available: number; errors: string[] }>("import_stock", { warehouse_code, rows, ...opts }),
  syncWarehouse: (code: string) => fn<{ ok: boolean; error?: string; message?: string; rows?: number; total_available?: number; notes?: string[]; errors?: string[] }>("sync_warehouse", { code }),
  providerWarehouses: (code: string) => fn<{ provider: string; warehouses: Array<{ ref: string; name: string; code: string | null; country: string | null; status: string | null }> }>("provider_warehouses", { code }),
  syncShop: (shop_id: string, cursor: unknown) => fn<{ done: boolean; cursor: unknown; slots?: number; orders?: number }>("sync_shop", { shop_id, cursor }),
  refreshMap: () => fn<{ total: number; multi_listing_skus: number; counts: Record<string, number> }>("refresh_map"),
  mapList: () => fn<{ rows: MapRow[] }>("map_list"),
  setOverride: (shop_id: string, sku_id: string, wh_sku: string) => fn<{ ok: true }>("set_override", { shop_id, sku_id, wh_sku }),
  stockList: (warehouse_code: string) => fn<{ rows: StockRow[] }>("stock_list", { warehouse_code }),
  buildPlan: (map_diff?: unknown) => fn<{ plan_id: string; summary: Record<string, unknown>; warnings: string[] }>("build_plan", { map_diff }),
  planGet: (plan_id?: string) => fn<{ plan: PlanRow; items: PlanItem[]; shops: SeaShop[] }>("plan_get", { plan_id }),
  planUpdate: (plan_id: string, items: Array<{ id: number; selected?: boolean; final_qty?: number | null }>) => fn<{ ok: true }>("plan_update", { plan_id, items }),
  execute: (plan_id: string, item_ids: number[]) =>
    fn<{ ok: number; failed: number; skipped: number; remaining: number; status: string }>("execute", { plan_id, item_ids, confirm: "EXECUTE" }),
};

/** 页面「发送到飞书」：走服务端路由（webhook 只在服务端） */
export async function sendPlanToFeishu(plan_id: string, passcode: string, name: string) {
  const r = await fetch("/api/public/hooks/sea-inventory-cron", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-passcode": passcode, "x-admin-name": encodeURIComponent(name) },
    body: JSON.stringify({ manual: true, plan_id }),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}
