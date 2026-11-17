// SEA 库存监控前端调用，全部走 Edge Function `sea-inventory`（tab 权限 sea-inventory）。
import * as XLSX from "xlsx";
import { invokeFn } from "@/lib/api";

export type WhLink = { shop_id: string; tts_warehouse_id: string };
export type SeaWarehouse = {
  code: string; name: string; provider: string; kind: "overseas" | "cn";
  status: "active" | "onboarding" | "phasing_out" | "disabled"; region: string | null; links: WhLink[];
  provider_ref: string | null; note: string | null; stock_synced_at: string | null; stock_source: string | null;
  stock_rows: number | null; stock_error: string | null;
};
export type SeaSettings = {
  window_days: number; min_days: number; min_qty: number; reserve_per_sku: number; zero_sale_qty: number;
  cn_min_days: number; cn_target_days: number; stock_max_age_hours: number; last_run_at: string | null; map_refreshed_at: string | null;
};
export type SeaShop = { shop_id: string; shop_name: string | null; region: string | null; seller_type: string | null; access_expires_at: string | null };
export type ShopSync = { shop_id: string; listings_at: string | null; orders_at: string | null; orders_count: number | null; slots_count: number | null; error: string | null };
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
  map_active: number; linked_shops: string[];
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
  shopWarehouses: (shop_id: string) => fn<{ warehouses: Array<{ id: string; name?: string; type?: string; sub_type?: string; is_default?: boolean; effect_status?: string; address?: { region_code?: string } }> }>("shop_warehouses", { shop_id }),
  importStock: (warehouse_code: string, rows: Array<{ wh_sku: string; available: number; on_hand?: number | null; product_name?: string | null }>) =>
    fn<{ ok: true; rows: number; total_available: number; errors: string[] }>("import_stock", { warehouse_code, rows }),
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

// ── 库存导入：xlsx / csv / 粘贴 ──────────────────────────────────────────────
const SKU_HEAD = /^(sku|仓库sku|商品sku|seller\s*sku|商家sku|sku编码|商品编码|编码)$/i;
const AVAIL_HEAD = /^(可用|可用库存|可用数量|可售|可售库存|available|available\s*qty|可用量)$/i;
const ONHAND_HEAD = /^(在库|实物库存|总库存|库存|on\s*hand|现有库存)$/i;
const NAME_HEAD = /^(商品名称|名称|品名|product\s*name|name)$/i;

export type ParsedStock = { rows: Array<{ wh_sku: string; available: number; on_hand: number | null; product_name: string | null }>; notes: string[] };

export function parseStockTable(table: unknown[][]): ParsedStock {
  const notes: string[] = [];
  // 找表头：前 10 行里同时有 SKU 列和可用列的第一行
  let hi = -1, cSku = -1, cAv = -1, cOn = -1, cName = -1;
  for (let i = 0; i < Math.min(10, table.length); i++) {
    const row = (table[i] ?? []).map((c) => String(c ?? "").trim());
    const s = row.findIndex((c) => SKU_HEAD.test(c));
    const a = row.findIndex((c) => AVAIL_HEAD.test(c));
    if (s >= 0 && a >= 0) { hi = i; cSku = s; cAv = a; cOn = row.findIndex((c) => ONHAND_HEAD.test(c)); cName = row.findIndex((c) => NAME_HEAD.test(c)); break; }
  }
  if (hi < 0) {
    // 无表头：按「第 1 列 SKU、第 2 列可用」
    hi = -1; cSku = 0; cAv = 1;
    notes.push("没找到表头（需要「SKU」和「可用库存」两列），按第 1 列 SKU、第 2 列可用数量读取");
  } else if (hi > 0) notes.push(`表头在第 ${hi + 1} 行，上面 ${hi} 行已忽略`);
  const rows: ParsedStock["rows"] = [];
  let skipped = 0;
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i] ?? [];
    const sku = String(r[cSku] ?? "").trim();
    const raw = String(r[cAv] ?? "").replace(/[,\s]/g, "");
    if (!sku && !raw) continue;
    const av = Number(raw);
    if (!sku || raw === "" || !Number.isFinite(av)) { skipped++; continue; }
    rows.push({
      wh_sku: sku, available: Math.max(0, Math.floor(av)),
      on_hand: cOn >= 0 && String(r[cOn] ?? "").trim() !== "" ? Number(String(r[cOn]).replace(/[,\s]/g, "")) : null,
      product_name: cName >= 0 ? String(r[cName] ?? "").trim() || null : null,
    });
  }
  if (skipped) notes.push(`${skipped} 行 SKU 为空或可用数量不是数字，已跳过`);
  return { rows, notes };
}

export async function parseStockFile(file: File): Promise<ParsedStock> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const notes: string[] = [];
  if (wb.SheetNames.length > 1) notes.push(`文件有 ${wb.SheetNames.length} 个 sheet，只读第一个「${wb.SheetNames[0]}」`);
  const table = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
  const p = parseStockTable(table);
  return { rows: p.rows, notes: [...notes, ...p.notes] };
}

export function parseStockPaste(text: string): ParsedStock {
  const table = text.split(/\r?\n/).map((l) => l.split(/\t|,/));
  return parseStockTable(table);
}
