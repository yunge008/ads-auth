// SEA 库存监控（tab key = sea-inventory）。规则与纯函数见 _shared/sea-inventory.ts。
//
// actions（页面需 sea-inventory 权限；cron 凭 x-cron-key 只放行 CRON_ACTIONS）：
//   overview                         设置 + 仓库 + 已授权店铺 + 同步状态 + 最新计划摘要
//   save_settings {…参数}
//   save_warehouse {code, name?, status?, links?, provider_ref?, note?}
//   shop_warehouses {shop_id}         只读：店铺在 TikTok 里的仓库列表（绑定仓库用）
//   import_stock {warehouse_code, rows:[{wh_sku, available, on_hand?, product_name?}], replace?=true}
//   sync_warehouse {code, force?}     配了云盘文件夹 → 取最新 RPA 导出文件（库存时间 = 文件修改时间，同一文件不重复导入）；否则从仓库系统 API 拉库存整仓覆盖（千易 QUERY_SIMPLE_LIST_INVENTORY_V2 / 顶妙 goods_sku_warehouse/search_page，见 _shared/wh-providers.ts）
//   drive_preview {code, drive_folder?, drive_name_pattern?, file_config?}  云盘：列文件 + 预览解析（不写库）
//   provider_warehouses {code}        仓库系统里的仓库列表（绑定 provider_ref 用：千易=仓库名称，顶妙=warehouseId）
//   sync_shop {shop_id, cursor?}      分片续跑：listings（Search Products）→ orders（近 N 天）→ 写 sea_inv_slots
//   refresh_map                       用最新 listing 重建映射表，返回新增 / 下架 / SKU 变化
//   build_plan {source?}              生成调整计划（旧的未执行计划标 SUPERSEDED）
//   plan_get {plan_id?}               计划 + 明细（默认最新一条）
//   plan_update {plan_id, items:[{id, selected?, final_qty?}]}
//   execute {plan_id, item_ids?, confirm:"EXECUTE"}   执行前实时读库存 → Update Inventory（INCREMENTAL）→ 逐条记结果；分片返回 remaining
//   build_message {plan_id?}          飞书卡片（由服务端路由发送）
import { admin, verifyPasscode } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { ttsCall, type TtsResult } from "../_shared/tts.ts";
import { downloadFile, listFolder, pickLatest } from "../_shared/gdrive.ts";
import { type FileConfig, parseStockWorkbook } from "../_shared/stock-file.ts";
import { dingmiaoInventory, dingmiaoWarehouses, qianyiInventory, qianyiWarehouses } from "../_shared/wh-providers.ts";
import {
  applySold,
  countSold,
  DEFAULT_PARAMS,
  diffMap,
  execQty,
  type MapRow,
  normSku,
  type OrderLite,
  type Params,
  planCn,
  planOverseas,
  type PlanItem,
  type Slot,
  sortByUrgency,
  type Warehouse,
  whSkuOf,
} from "../_shared/sea-inventory.ts";

const TAB = "sea-inventory";
const CRON_ACTIONS = new Set(["overview", "sync_shop", "sync_warehouse", "refresh_map", "build_plan", "build_message"]);
const SOFT_MS = 100_000;

type Shop = { shop_id: string; shop_cipher: string; shop_name: string | null; region: string | null; access_token: string; access_expires_at: string | null; seller_type?: string | null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
function bad(msg: string): never {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  throw e;
}
const apiErr = (name: string, r: TtsResult) => `${name} 失败：http=${r.http_status} code=${r.code} ${r.message} request_id=${r.request_id}`;
const nowIso = () => new Date().toISOString();

async function loadShop(id: string): Promise<Shop> {
  const { data, error } = await admin().from("tts_shops")
    .select("shop_id,shop_cipher,shop_name,region,access_token,access_expires_at,seller_type").eq("shop_id", id).maybeSingle();
  if (error) throw error;
  if (!data) bad(`tts_shops 里没有 shop_id=${id}`);
  const s = data as Shop;
  if (s.access_expires_at && Date.parse(s.access_expires_at) < Date.now()) {
    bad(`店铺 ${s.shop_name ?? id} 的 access_token 已过期（${s.access_expires_at}），到「设置 → TikTok Shop 授权」刷新`);
  }
  return s;
}

async function loadParams(): Promise<Params & { stock_max_age_hours: number }> {
  const { data, error } = await admin().from("sea_inv_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const n = (k: keyof Params) => (d[k] === undefined || d[k] === null ? DEFAULT_PARAMS[k] : Number(d[k]));
  return {
    window_days: n("window_days"), min_days: n("min_days"), min_qty: n("min_qty"), reserve_per_sku: n("reserve_per_sku"),
    zero_sale_qty: n("zero_sale_qty"), cn_min_days: n("cn_min_days"), cn_target_days: n("cn_target_days"),
    stock_max_age_hours: Number(d.stock_max_age_hours ?? 26),
  };
}

async function loadWarehouses(): Promise<Array<Warehouse & Record<string, unknown>>> {
  const { data, error } = await admin().from("sea_inv_warehouses").select("*").order("sort");
  if (error) throw error;
  return (data ?? []).map((w) => ({ ...w, links: Array.isArray(w.links) ? w.links : [] })) as never;
}

/** 所有仓库绑定到的店铺（只同步这些店铺） */
function linkedShops(whs: Warehouse[]): string[] {
  return [...new Set(whs.filter((w) => w.status !== "disabled").flatMap((w) => w.links.map((l) => l.shop_id)))];
}

// ── overview ───────────────────────────────────────────────────────────────
async function overview() {
  const db = admin();
  const [settings, warehouses, shops, sync, plan, mapCount] = await Promise.all([
    db.from("sea_inv_settings").select("*").eq("id", 1).maybeSingle(),
    loadWarehouses(),
    db.from("tts_shops").select("shop_id,shop_name,region,seller_type,access_expires_at").order("region"),
    db.from("sea_inv_shop_sync").select("*"),
    db.from("sea_inv_plans").select("id,created_at,source,status,summary,executed_at,executed_by").order("created_at", { ascending: false }).limit(10),
    db.from("sea_inv_sku_map").select("shop_id", { count: "exact", head: true }).eq("active", true),
  ]);
  return {
    settings: settings.data, warehouses, shops: shops.data ?? [], shop_sync: sync.data ?? [],
    plans: plan.data ?? [], map_active: mapCount.count ?? 0, linked_shops: linkedShops(warehouses),
  };
}

// ── 仓库库存 ───────────────────────────────────────────────────────────────
async function importStock(b: Record<string, unknown>, source = "manual", asOf?: string, extra: Record<string, unknown> = {}) {
  const code = String(b.warehouse_code ?? "");
  if (!code) bad("warehouse_code 必填");
  const rows = (Array.isArray(b.rows) ? b.rows : []) as Array<Record<string, unknown>>;
  const clean = new Map<string, { wh_sku: string; available: number; on_hand: number | null; product_name: string | null }>();
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const sku = normSku(r.wh_sku as string);
    const av = Number(r.available);
    if (!sku) return;
    if (!Number.isFinite(av) || av < 0 || !Number.isInteger(av)) { errors.push(`第 ${i + 1} 行 ${sku} 可用数量「${r.available}」不是非负整数，已跳过`); return; }
    if (clean.has(sku)) errors.push(`SKU ${sku} 重复出现，后一行覆盖前一行`);
    clean.set(sku, { wh_sku: sku, available: av, on_hand: r.on_hand === undefined || r.on_hand === "" ? null : Number(r.on_hand), product_name: r.product_name ? String(r.product_name) : null });
  });
  if (!clean.size) bad(`没有有效行（${errors.slice(0, 3).join("；")}）`);
  const db = admin();
  // 库存时间：云盘文件用文件修改时间（= RPA 导出时间），否则用当前时间；过期判断按这个时间
  const t = asOf ?? nowIso();
  if (b.replace !== false) {
    const { error } = await db.from("sea_inv_wh_stock").delete().eq("warehouse_code", code);
    if (error) throw error;
  }
  const list = [...clean.values()].map((r) => ({ ...r, warehouse_code: code, source, fetched_at: t }));
  for (let i = 0; i < list.length; i += 500) {
    const { error } = await db.from("sea_inv_wh_stock").upsert(list.slice(i, i + 500), { onConflict: "warehouse_code,wh_sku" });
    if (error) throw error;
  }
  await db.from("sea_inv_warehouses").update({ stock_synced_at: t, stock_source: source, stock_rows: list.length, stock_error: null, updated_at: nowIso(), ...extra }).eq("code", code);
  return { ok: true, rows: list.length, total_available: list.reduce((s, r) => s + r.available, 0), errors };
}

type WhRow = {
  code: string; name: string; provider: string; provider_ref: string | null;
  drive_folder: string | null; drive_name_pattern: string | null; file_config: FileConfig | null;
  stock_file_id: string | null; stock_file_modified: string | null;
};
async function loadWh(code: string): Promise<WhRow> {
  const { data: w } = await admin().from("sea_inv_warehouses").select("*").eq("code", code).maybeSingle();
  if (!w) bad(`仓库 ${code} 不存在`);
  return w as WhRow;
}

/** 云盘：取文件夹里最新一份库存表（RPA 导出），同一文件同一修改时间不重复导入 */
async function syncFromDrive(w: WhRow, force: boolean) {
  const files = await listFolder(w.drive_folder!);
  const f = pickLatest(files, w.drive_name_pattern);
  if (!f) throw new Error(`云盘文件夹里没有${w.drive_name_pattern ? `文件名含「${w.drive_name_pattern}」的` : ""}表格文件（xlsx/xls/csv/Google 表格），共 ${files.length} 个文件`);
  if (!force && f.id === w.stock_file_id && w.stock_file_modified && Date.parse(w.stock_file_modified) === Date.parse(f.modifiedTime)) {
    return { ok: true, unchanged: true, file: f.name, file_time: f.modifiedTime, message: `云盘最新文件「${f.name}」已导入过，未变化` };
  }
  const bytes = await downloadFile(f);
  const p = parseStockWorkbook(bytes, w.file_config ?? {});
  if (!p.rows.length) throw new Error(`解析「${f.name}」得到 0 个 SKU，未覆盖原库存：${p.notes.join("；")}`);
  const res = await importStock({ warehouse_code: w.code, rows: p.rows }, "drive", new Date(f.modifiedTime).toISOString(),
    { stock_file_name: f.name, stock_file_id: f.id, stock_file_modified: f.modifiedTime });
  return { ...res, file: f.name, file_time: f.modifiedTime, sheet: p.sheet, notes: p.notes };
}

async function syncWarehouse(code: string, force = false) {
  const db = admin();
  const w = await loadWh(code);
  const useDrive = !!(w.drive_folder ?? "").trim();
  if (!useDrive && !["qianyi", "dingmiao"].includes(w.provider)) {
    return { ok: true, skipped: true, message: w.provider === "tiktok" ? "国内仓不同步实物库存" : `${w.name} 没有 API，也没配云盘文件夹，用页面「导入库存」` };
  }
  try {
    if (useDrive) return await syncFromDrive(w, force);
    const r = w.provider === "qianyi" ? await qianyiInventory(w.provider_ref ?? "") : await dingmiaoInventory(w.provider_ref ?? "");
    const valid = r.rows.filter((x) => x.wh_sku);
    if (!valid.length) throw new Error("接口返回 0 个 SKU，未覆盖原库存（请确认仓库系统仓库选对了）");
    const neg = valid.filter((x) => x.available < 0);
    const res = await importStock({ warehouse_code: code, rows: valid.map((x) => ({ ...x, available: Math.max(0, x.available) })) }, "api");
    return { ...res, notes: [...r.notes, ...(neg.length ? [`${neg.length} 个 SKU 可用为负数，按 0 计`] : [])] };
  } catch (e) {
    const err = (e as Error).message;
    await db.from("sea_inv_warehouses").update({ stock_error: err, updated_at: nowIso() }).eq("code", code);
    return { ok: false, error: err };
  }
}

/** 云盘预览：列出文件夹里的文件、会选中哪份、解析结果前 20 行（不写库） */
async function drivePreview(b: Record<string, unknown>) {
  const w = await loadWh(String(b.code ?? ""));
  const folder = String(b.drive_folder ?? w.drive_folder ?? "").trim();
  if (!folder) bad("先填云盘文件夹链接");
  const pattern = b.drive_name_pattern !== undefined ? String(b.drive_name_pattern) : w.drive_name_pattern;
  const cfg = (b.file_config ?? w.file_config ?? {}) as FileConfig;
  const files = await listFolder(folder);
  const f = pickLatest(files, pattern);
  if (!f) return { files: files.slice(0, 20), picked: null, rows: [], notes: ["没有符合条件的表格文件"] };
  const p = parseStockWorkbook(await downloadFile(f), cfg);
  return { files: files.slice(0, 20), picked: f, sheet: p.sheet, header_row: p.header_row, count: p.rows.length, total_available: p.rows.reduce((t, r) => t + r.available, 0), rows: p.rows.slice(0, 20), notes: p.notes };
}

async function providerWarehouses(code: string) {
  const w = await loadWh(code);
  if (w.provider === "qianyi") return { provider: w.provider, warehouses: await qianyiWarehouses() };
  if (w.provider === "dingmiao") return { provider: w.provider, warehouses: await dingmiaoWarehouses() };
  bad(`${w.name} 没有仓库系统 API`);
}

// ── 店铺 listing + 订单 ─────────────────────────────────────────────────────
type SearchProducts = {
  products?: Array<{ id: string; title?: string; status?: string; skus?: Array<{ id: string; seller_sku?: string; inventory?: Array<{ warehouse_id?: string; quantity?: number }>; status_info?: { status?: string } }> }>;
  next_page_token?: string;
};
type Cursor = { stage: "listings" | "orders"; run_at: string; page_token?: string; counts?: Record<string, number>; orders?: number; slots?: number };

async function syncShop(b: Record<string, unknown>) {
  const shopId = String(b.shop_id ?? "");
  if (!shopId) bad("shop_id 必填");
  const shop = await loadShop(shopId);
  const p = await loadParams();
  const db = admin();
  const started = Date.now();
  const cur: Cursor = (b.cursor as Cursor) ?? { stage: "listings", run_at: nowIso() };
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const errors: string[] = [];

  if (cur.stage === "listings") {
    do {
      const r = await ttsCall<SearchProducts>({
        ...T, method: "POST", path: "/product/202502/products/search",
        query: { page_size: 100, page_token: cur.page_token }, body: { status: "ACTIVATE" },
      });
      if (r.code !== 0) {
        const msg = apiErr("products/search", r);
        await db.from("sea_inv_shop_sync").upsert({ shop_id: shopId, error: msg, updated_at: nowIso() });
        bad(msg);
      }
      const rows: Record<string, unknown>[] = [];
      for (const pr of r.data?.products ?? []) {
        for (const sk of pr.skus ?? []) {
          if (sk.status_info?.status === "DEACTIVATED") continue;
          for (const inv of sk.inventory ?? []) {
            if (!inv.warehouse_id) continue;
            rows.push({
              shop_id: shopId, sku_id: sk.id, tts_warehouse_id: inv.warehouse_id, product_id: pr.id, region: shop.region,
              seller_sku: normSku(sk.seller_sku), title: pr.title ?? null, qty: Number(inv.quantity ?? 0), sold: 0, synced_at: cur.run_at,
            });
          }
        }
      }
      if (rows.length) {
        // 保留旧 sold，直到本次订单阶段重算（避免中途失败时销量被清零）
        const { error } = await db.from("sea_inv_slots").upsert(rows.map(({ sold: _s, ...x }) => x), { onConflict: "shop_id,sku_id,tts_warehouse_id" });
        if (error) throw error;
      }
      cur.slots = (cur.slots ?? 0) + rows.length;
      cur.page_token = r.data?.next_page_token || undefined;
    } while (cur.page_token && Date.now() - started < SOFT_MS);
    if (cur.page_token) return { done: false, cursor: cur, errors };
    // 本次没出现的槽位（下架 / 解除仓库）删除
    const { error } = await db.from("sea_inv_slots").delete().eq("shop_id", shopId).lt("synced_at", cur.run_at);
    if (error) throw error;
    await db.from("sea_inv_shop_sync").upsert({ shop_id: shopId, listings_at: nowIso(), slots_count: cur.slots ?? 0, error: null, updated_at: nowIso() });
    Object.assign(cur, { stage: "orders", page_token: undefined, counts: {}, orders: 0 });
  }

  // orders：近 window_days 天下单（含当天）
  const from = Math.floor(Date.now() / 1000) - p.window_days * 86400;
  const counts = new Map(Object.entries(cur.counts ?? {}));
  do {
    const r = await ttsCall<{ orders?: OrderLite[]; next_page_token?: string }>({
      ...T, method: "POST", path: "/order/202309/orders/search",
      query: { page_size: 100, sort_field: "create_time", sort_order: "ASC", page_token: cur.page_token },
      body: { create_time_ge: from },
    });
    if (r.code !== 0) {
      const msg = apiErr("orders/search", r);
      await db.from("sea_inv_shop_sync").upsert({ shop_id: shopId, error: msg, updated_at: nowIso() });
      bad(msg);
    }
    const orders = r.data?.orders ?? [];
    countSold(orders, counts);
    cur.orders = (cur.orders ?? 0) + orders.length;
    cur.page_token = r.data?.next_page_token || undefined;
  } while (cur.page_token && Date.now() - started < SOFT_MS);
  cur.counts = Object.fromEntries(counts);
  if (cur.page_token) return { done: false, cursor: cur, errors };

  const { data: slots, error } = await db.from("sea_inv_slots").select("*").eq("shop_id", shopId);
  if (error) throw error;
  const withSold = applySold((slots ?? []) as Slot[], counts);
  for (let i = 0; i < withSold.length; i += 500) {
    const chunk = withSold.slice(i, i + 500).map((s) => ({ shop_id: s.shop_id, sku_id: s.sku_id, tts_warehouse_id: s.tts_warehouse_id, product_id: s.product_id, sold: s.sold }));
    const { error: e2 } = await db.from("sea_inv_slots").upsert(chunk, { onConflict: "shop_id,sku_id,tts_warehouse_id" });
    if (e2) throw e2;
  }
  await db.from("sea_inv_shop_sync").upsert({
    shop_id: shopId, orders_at: nowIso(), orders_from: new Date(from * 1000).toISOString(), orders_count: cur.orders ?? 0, error: null, updated_at: nowIso(),
  });
  return { done: true, cursor: null, slots: withSold.length, orders: cur.orders ?? 0, errors };
}

// ── 映射表 ─────────────────────────────────────────────────────────────────
async function allSlots(): Promise<Slot[]> {
  const out: Slot[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin().from("sea_inv_slots").select("*").range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as Slot[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function allMap(): Promise<Array<MapRow & { wh_sku_override: string | null; active: boolean }>> {
  const out: Array<MapRow & { wh_sku_override: string | null; active: boolean }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin().from("sea_inv_sku_map").select("*").range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) out.push({ ...r, wh_sku: normSku(r.wh_sku_override ?? r.seller_sku) } as never);
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function refreshMap() {
  const db = admin();
  const slots = await allSlots();
  const prev = (await allMap()).filter((r) => r.active);
  const overrides = new Map(prev.filter((r) => r.wh_sku_override).map((r) => [`${r.shop_id}|${r.sku_id}`, r.wh_sku_override!]));
  const nextMap = new Map<string, MapRow>();
  for (const s of slots) {
    nextMap.set(`${s.shop_id}|${s.sku_id}`, { shop_id: s.shop_id, sku_id: s.sku_id, product_id: s.product_id, seller_sku: normSku(s.seller_sku), wh_sku: whSkuOf(s, overrides) });
  }
  const next = [...nextMap.values()];
  const diff = diffMap(prev, next);
  const t = nowIso();
  const changedKeys = new Map(diff.changed.map((c) => [`${c.after.shop_id}|${c.after.sku_id}`, c.before.seller_sku]));
  const rows = next.map((r) => {
    const k = `${r.shop_id}|${r.sku_id}`;
    const base: Record<string, unknown> = { shop_id: r.shop_id, sku_id: r.sku_id, product_id: r.product_id, seller_sku: r.seller_sku, active: true, last_seen_at: t };
    if (changedKeys.has(k)) Object.assign(base, { prev_seller_sku: changedKeys.get(k), changed_at: t });
    return base;
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("sea_inv_sku_map").upsert(rows.slice(i, i + 500), { onConflict: "shop_id,sku_id" });
    if (error) throw error;
  }
  for (const r of diff.removed) {
    await db.from("sea_inv_sku_map").update({ active: false, changed_at: t }).eq("shop_id", r.shop_id).eq("sku_id", r.sku_id);
  }
  await db.from("sea_inv_settings").update({ map_refreshed_at: t }).eq("id", 1);
  // 同一仓库 SKU 下挂了几个 listing（多 listing 同 SKU）
  const multi = new Map<string, number>();
  for (const r of next) multi.set(r.wh_sku, (multi.get(r.wh_sku) ?? 0) + 1);
  return {
    total: next.length,
    multi_listing_skus: [...multi.values()].filter((n) => n > 1).length,
    diff: { added: diff.added.slice(0, 200), removed: diff.removed.slice(0, 200), changed: diff.changed.slice(0, 200) },
    counts: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
  };
}

// ── 生成计划 ───────────────────────────────────────────────────────────────
async function buildPlan(b: Record<string, unknown>, who: string) {
  const db = admin();
  const p = await loadParams();
  const whs = await loadWarehouses();
  const warnings: string[] = [];
  const slots = await allSlots();

  // 数据新鲜度：店铺
  const { data: syncRows } = await db.from("sea_inv_shop_sync").select("*");
  const syncMap = new Map((syncRows ?? []).map((r) => [r.shop_id, r]));
  const badShops = new Set<string>();
  for (const sid of linkedShops(whs)) {
    const r = syncMap.get(sid);
    const age = r?.orders_at ? (Date.now() - Date.parse(r.orders_at)) / 3600_000 : Infinity;
    if (!r || r.error || age > 14) {
      badShops.add(sid);
      warnings.push(`店铺 ${sid} listing/订单${r?.error ? `同步失败：${String(r.error).slice(0, 160)}` : age === Infinity ? "从未同步" : `已 ${Math.floor(age)} 小时未同步`}，该店铺本次不生成调整`);
    }
  }
  // 数据新鲜度：海外仓库存（过期的仓库不参与，绝不拿旧库存分配）
  const stock = new Map<string, Map<string, number>>();
  const usable: Warehouse[] = [];
  for (const w of whs) {
    if (w.status === "disabled") continue;
    if (!w.links.length) { if (w.kind === "overseas") warnings.push(`${w.name} 未绑定任何店铺的 TikTok 仓库，跳过`); continue; }
    if (w.kind === "cn") { usable.push(w); continue; }
    const at = w.stock_synced_at as string | null;
    const age = at ? (Date.now() - Date.parse(at)) / 3600_000 : Infinity;
    if (age > p.stock_max_age_hours) {
      warnings.push(`${w.name} 库存${at ? `已 ${Math.floor(age)} 小时未更新` : "从未导入/同步"}${w.stock_error ? `（${String(w.stock_error).slice(0, 120)}）` : ""}，本次不调整该仓`);
      continue;
    }
    const m = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("sea_inv_wh_stock").select("wh_sku,available").eq("warehouse_code", w.code).range(from, from + 999);
      if (error) throw error;
      for (const r of data ?? []) m.set(normSku(r.wh_sku), Number(r.available));
      if (!data || data.length < 1000) break;
    }
    stock.set(w.code, m);
    usable.push(w);
  }
  const okSlots = slots.filter((s) => !badShops.has(s.shop_id));
  const map = await allMap();
  const overrides = new Map(map.filter((r) => r.wh_sku_override).map((r) => [`${r.shop_id}|${r.sku_id}`, r.wh_sku_override!]));
  const ov = planOverseas({ warehouses: usable, slots: okSlots, stock, overrides, params: p });
  const cn = planCn(usable, okSlots, p);
  const items = sortByUrgency([...ov.items, ...cn]);
  const missing = ov.groups.filter((g) => g.wh_available === null);
  const summary = {
    overseas: ov.items.length, cn: cn.length, groups_checked: ov.groups.length, groups_triggered: ov.groups.filter((g) => g.triggered).length,
    missing_in_warehouse: missing.length, missing_sample: missing.slice(0, 50),
    min_days_overseas: minDays(ov.items), min_days_cn: minDays(cn), slots: okSlots.length,
  };

  await db.from("sea_inv_plans").update({ status: "SUPERSEDED" }).eq("status", "PENDING");
  const { data: plan, error } = await db.from("sea_inv_plans").insert({
    source: String(b.source ?? "MANUAL"), created_by: who, params: p, summary, data_warnings: warnings, map_diff: b.map_diff ?? null,
  }).select("id").single();
  if (error) throw error;
  const rows = items.map((i) => ({ ...i, plan_id: plan.id }));
  for (let k = 0; k < rows.length; k += 500) {
    const { error: e2 } = await db.from("sea_inv_plan_items").insert(rows.slice(k, k + 500));
    if (e2) throw e2;
  }
  await db.from("sea_inv_settings").update({ last_run_at: nowIso(), last_run_summary: { plan_id: plan.id, ...summary, warnings: warnings.length } }).eq("id", 1);
  return { plan_id: plan.id, summary, warnings };
}
function minDays(items: PlanItem[]): number | null {
  const xs = items.filter((i) => !i.new_link && i.days_before !== null).map((i) => i.days_before!);
  return xs.length ? Math.min(...xs) : null;
}

async function latestPlanId(): Promise<string> {
  const { data } = await admin().from("sea_inv_plans").select("id").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) bad("还没有任何调整计划");
  return data.id;
}

async function planGet(b: Record<string, unknown>) {
  const id = b.plan_id ? String(b.plan_id) : await latestPlanId();
  const db = admin();
  const { data: plan, error } = await db.from("sea_inv_plans").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!plan) bad("计划不存在");
  const items: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: e2 } = await db.from("sea_inv_plan_items").select("*").eq("plan_id", id).order("id").range(from, from + 999);
    if (e2) throw e2;
    items.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { data: shops } = await db.from("tts_shops").select("shop_id,shop_name,region");
  return { plan, items, shops: shops ?? [] };
}

async function planUpdate(b: Record<string, unknown>) {
  const id = String(b.plan_id ?? "");
  const db = admin();
  const { data: plan } = await db.from("sea_inv_plans").select("status").eq("id", id).maybeSingle();
  if (!plan) bad("计划不存在");
  if (plan.status !== "PENDING" && plan.status !== "PARTIAL") bad(`计划状态 ${plan.status}，不能再修改`);
  for (const it of (Array.isArray(b.items) ? b.items : []) as Array<Record<string, unknown>>) {
    const patch: Record<string, unknown> = {};
    if (it.selected !== undefined) patch.selected = !!it.selected;
    if (it.final_qty !== undefined) {
      if (it.final_qty === null || it.final_qty === "") patch.final_qty = null;
      else {
        const q = Number(it.final_qty);
        if (!Number.isInteger(q) || q < 0 || q > 99_999) bad(`数量 ${it.final_qty} 不合法（0–99999 整数）`);
        patch.final_qty = q;
      }
    }
    if (Object.keys(patch).length) {
      const { error } = await db.from("sea_inv_plan_items").update(patch).eq("id", Number(it.id)).eq("plan_id", id).eq("exec_status", "PENDING");
      if (error) throw error;
    }
  }
  return { ok: true };
}

// ── 执行 ───────────────────────────────────────────────────────────────────
type ItemRow = PlanItem & { id: number; final_qty: number | null; selected: boolean; exec_status: string };

async function liveQty(shop: Shop, skuIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < skuIds.length; i += 600) {
    const r = await ttsCall<{ inventory?: Array<{ skus?: Array<{ id: string; warehouse_inventory?: Array<{ warehouse_id: string; available_quantity?: number }> }> }> }>({
      method: "POST", path: "/product/202309/inventory/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      body: { sku_ids: skuIds.slice(i, i + 600) },
    });
    if (r.code !== 0) throw new Error(apiErr("inventory/search", r));
    for (const p of r.data?.inventory ?? []) for (const s of p.skus ?? []) for (const w of s.warehouse_inventory ?? []) {
      out.set(`${s.id}|${w.warehouse_id}`, Number(w.available_quantity ?? 0));
    }
  }
  return out;
}

async function execute(b: Record<string, unknown>, who: string) {
  if (b.confirm !== "EXECUTE") bad('执行需要 confirm:"EXECUTE"');
  const id = String(b.plan_id ?? "");
  const db = admin();
  const { data: plan } = await db.from("sea_inv_plans").select("*").eq("id", id).maybeSingle();
  if (!plan) bad("计划不存在");
  if (!["PENDING", "PARTIAL", "EXECUTING"].includes(plan.status)) bad(`计划状态 ${plan.status}，不能执行（已被新计划替代或已执行）`);
  const ageH = (Date.now() - Date.parse(plan.created_at)) / 3600_000;
  if (ageH > 14) bad(`计划生成于 ${Math.floor(ageH)} 小时前，数据已旧，请先重新生成`);
  let q = db.from("sea_inv_plan_items").select("*").eq("plan_id", id).eq("exec_status", "PENDING").eq("selected", true);
  const ids = Array.isArray(b.item_ids) ? (b.item_ids as unknown[]).map(Number) : null;
  if (ids) q = q.in("id", ids);
  const { data: items, error } = await q;
  if (error) throw error;
  await db.from("sea_inv_plans").update({ status: "EXECUTING", executed_by: who }).eq("id", id);

  const started = Date.now();
  const byShop = new Map<string, ItemRow[]>();
  for (const it of (items ?? []) as ItemRow[]) byShop.set(it.shop_id, [...(byShop.get(it.shop_id) ?? []), it]);
  let ok = 0, failed = 0, skipped = 0, remaining = 0;
  const mark = (itemId: number, patch: Record<string, unknown>) =>
    db.from("sea_inv_plan_items").update({ ...patch, exec_at: nowIso() }).eq("id", itemId);

  for (const [shopId, list] of byShop) {
    if (Date.now() - started > SOFT_MS) { remaining += list.length; continue; }
    let shop: Shop;
    try { shop = await loadShop(shopId); } catch (e) {
      for (const it of list) await mark(it.id, { exec_status: "FAILED", exec_message: (e as Error).message });
      failed += list.length; continue;
    }
    let live: Map<string, number>;
    try { live = await liveQty(shop, [...new Set(list.map((i) => i.sku_id))]); } catch (e) {
      for (const it of list) await mark(it.id, { exec_status: "FAILED", exec_message: `执行前读实时库存失败：${(e as Error).message}` });
      failed += list.length; continue;
    }
    const byProduct = new Map<string, ItemRow[]>();
    for (const it of list) byProduct.set(it.product_id, [...(byProduct.get(it.product_id) ?? []), it]);
    for (const [productId, its] of byProduct) {
      if (Date.now() - started > SOFT_MS) { remaining += its.length; continue; }
      const send: Array<{ it: ItemRow; qty: number; live: number | null }> = [];
      for (const it of its) {
        const lv = live.has(`${it.sku_id}|${it.tts_warehouse_id}`) ? live.get(`${it.sku_id}|${it.tts_warehouse_id}`)! : (it.new_link ? 0 : null);
        const qty = it.final_qty ?? execQty(it, lv);
        if (qty < 1) {
          await mark(it.id, { exec_status: "SKIPPED", live_qty: lv, exec_qty: qty, exec_message: "目标 0：接口 quantity 范围 1–99,999，未执行；请在 Seller Center 手动处理（下架或解除该仓关联）" });
          skipped++; continue;
        }
        if (lv !== null && lv === qty) {
          await mark(it.id, { exec_status: "SKIPPED", live_qty: lv, exec_qty: qty, exec_message: "实时库存已等于目标，无需修改" });
          skipped++; continue;
        }
        send.push({ it, qty, live: lv });
      }
      if (!send.length) continue;
      // 同一 SKU 多个仓库合并到一个 skus 元素
      const bySku = new Map<string, Array<{ warehouse_id: string; quantity: number }>>();
      for (const s of send) bySku.set(s.it.sku_id, [...(bySku.get(s.it.sku_id) ?? []), { warehouse_id: s.it.tts_warehouse_id, quantity: Math.min(99_999, s.qty) }]);
      const body = { sku_warehouse_stock_update_mode: "INCREMENTAL", skus: [...bySku].map(([sid, inv]) => ({ id: sid, inventory: inv })) };
      const r = await ttsCall<{ errors?: Array<{ code?: number; message?: string; detail?: { sku_id?: string; extra_errors?: Array<{ warehouse_id?: string; code?: number; message?: string }> } }> }>({
        method: "POST", path: `/product/202309/products/${productId}/inventory/update`, accessToken: shop.access_token, shopCipher: shop.shop_cipher,
        body, write: true,
      });
      if (r.code !== 0) {
        const hint = r.code === 12052141 ? "（跨境店：库存需在全球商品上改，当前未对接全球商品仓库映射）" : r.code === 12052165 ? "（活动预留库存不足以覆盖）" : "";
        for (const s of send) await mark(s.it.id, { exec_status: "FAILED", live_qty: s.live, exec_qty: s.qty, exec_message: apiErr("inventory/update", r) + hint });
        failed += send.length; continue;
      }
      const errs = r.data?.errors ?? [];
      for (const s of send) {
        const e = errs.find((x) => x.detail?.sku_id === s.it.sku_id && (!x.detail?.extra_errors?.length || x.detail.extra_errors.some((w) => !w.warehouse_id || w.warehouse_id === s.it.tts_warehouse_id)));
        if (e) {
          const sub = e.detail?.extra_errors?.map((w) => `${w.code} ${w.message}`).join("；") ?? "";
          await mark(s.it.id, { exec_status: "FAILED", live_qty: s.live, exec_qty: s.qty, exec_message: `${e.code} ${e.message} ${sub}`.trim() });
          failed++;
        } else {
          await mark(s.it.id, { exec_status: "OK", live_qty: s.live, exec_qty: s.qty, exec_message: `request_id=${r.request_id}` });
          ok++;
        }
      }
    }
  }
  const { count: pending } = await db.from("sea_inv_plan_items").select("id", { count: "exact", head: true }).eq("plan_id", id).eq("exec_status", "PENDING").eq("selected", true);
  const { count: bad_ } = await db.from("sea_inv_plan_items").select("id", { count: "exact", head: true }).eq("plan_id", id).eq("exec_status", "FAILED");
  const status = remaining ? "EXECUTING" : (pending ?? 0) > 0 || (bad_ ?? 0) > 0 ? "PARTIAL" : "DONE";
  await db.from("sea_inv_plans").update({ status, executed_at: nowIso(), executed_by: who }).eq("id", id);
  return { ok, failed, skipped, remaining, status };
}

// ── 飞书卡片 ───────────────────────────────────────────────────────────────
const fmtDays = (d: number | null) => (d === null ? "无销量" : d.toFixed(1));
function dayColor(d: number | null): string {
  if (d === null) return "grey";
  if (d < 3) return "red";
  if (d < 7) return "orange";
  return "yellow";
}

async function buildMessage(b: Record<string, unknown>) {
  const { plan, items, shops } = await planGet(b) as { plan: Record<string, unknown>; items: ItemRow[]; shops: Array<{ shop_id: string; shop_name: string | null; region: string | null }> };
  const shopName = new Map(shops.map((s) => [s.shop_id, s.shop_name ?? s.region ?? s.shop_id]));
  const whs = new Map((await loadWarehouses()).map((w) => [w.code, w.name]));
  const ov = items.filter((i) => i.kind === "overseas");
  const cn = items.filter((i) => i.kind === "cn");
  const warnings = (plan.data_warnings as string[] | null) ?? [];
  const md = (plan.map_diff as { counts?: { added: number; removed: number; changed: number } } | null)?.counts;
  const all = [...ov, ...cn].filter((i) => !i.new_link && i.days_before !== null);
  const worst = all.length ? Math.min(...all.map((i) => i.days_before!)) : null;
  const template = !items.length ? (warnings.length ? "orange" : "green") : worst !== null && worst < 3 ? "red" : worst !== null && worst < 7 ? "orange" : "yellow";
  const bjTime = new Date(String(plan.created_at)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

  const table = (list: ItemRow[], withWh: boolean) => ({
    tag: "table",
    page_size: 10,
    row_height: "low",
    header_style: { text_align: "left", text_size: "normal", background_style: "grey", bold: true, lines: 1 },
    columns: [
      { name: "sku", display_name: "SKU", data_type: "text", width: "auto" },
      { name: "shop", display_name: withWh ? "店铺 / 仓" : "店铺", data_type: "text", width: "auto" },
      { name: "qty", display_name: "当前→建议", data_type: "text", width: "auto" },
      { name: "days", display_name: "可售天数", data_type: "lark_md", width: "auto" },
    ],
    rows: list.slice(0, 15).map((i) => ({
      sku: i.seller_sku || i.sku_id,
      shop: withWh ? `${shopName.get(i.shop_id) ?? i.shop_id} / ${whs.get(i.warehouse_code) ?? i.warehouse_code}` : String(shopName.get(i.shop_id) ?? i.shop_id),
      qty: `${i.current_qty} → ${i.proposed_qty}${i.new_link ? "（新仓）" : ""}`,
      days: `<font color='${dayColor(i.days_before)}'>${fmtDays(i.days_before)}</font> → ${fmtDays(i.days_after)}`,
    })),
  });

  const skuCount = (l: ItemRow[]) => new Set(l.map((i) => i.wh_sku)).size;
  const elements: unknown[] = [];
  if (warnings.length) {
    elements.push({ tag: "markdown", content: warnings.slice(0, 8).map((w) => `<font color='red'>⚠ ${w}</font>`).join("\n") }, { tag: "hr" });
  }
  elements.push({
    tag: "markdown",
    content: [
      `**生成时间**：${bjTime}（${plan.source === "CRON" ? "定时" : "手动"}）`,
      `**海外仓**：${ov.length} 条（${skuCount(ov)} 个 SKU）${ov.length ? `，最紧急可售 **<font color='${dayColor(minDays(ov))}'>${fmtDays(minDays(ov))} 天</font>**` : ""}`,
      `**国内仓**：${cn.length} 条（${skuCount(cn)} 个 SKU）${cn.length ? `，最紧急可售 **<font color='${dayColor(minDays(cn))}'>${fmtDays(minDays(cn))} 天</font>**` : ""}`,
      md && (md.added || md.removed || md.changed) ? `**映射表变化**：新增 ${md.added}、下架 ${md.removed}、SKU 变更 ${md.changed}` : "",
    ].filter(Boolean).join("\n"),
  });
  if (ov.length) elements.push({ tag: "markdown", content: "**海外仓（按紧急度，前 15 条）**" }, table(ov, true));
  if (cn.length) elements.push({ tag: "markdown", content: "**国内仓（按紧急度，前 15 条）**\n<font color='grey'>国内仓实物未接入，确认前请核对仓库有货</font>" }, table(cn, false));
  elements.push({ tag: "markdown", content: items.length ? "请到网页「SEA库存监控」核对并点「确认执行」，**未确认不会改任何库存**。" : "本次没有需要调整的 listing。" });

  const title = items.length
    ? `SEA 库存调整计划：海外仓 ${skuCount(ov)} 个 SKU / 国内仓 ${skuCount(cn)} 个 SKU 待确认`
    : warnings.length ? "SEA 库存监控：无调整，但有数据异常" : "SEA 库存监控：本次无需调整";
  const card = { config: { wide_screen_mode: true }, header: { template, title: { tag: "plain_text", content: title } }, elements };
  // 纯文本兜底（卡片表格组件被拒时由路由改发这个）
  const lines = [
    title, `生成时间：${bjTime}`, ...warnings.map((w) => `⚠ ${w}`),
    ...[...ov.slice(0, 10), ...cn.slice(0, 10)].map((i) => `[${i.kind === "cn" ? "国内仓" : whs.get(i.warehouse_code) ?? i.warehouse_code}] ${i.seller_sku} ${shopName.get(i.shop_id) ?? ""}：${i.current_qty}→${i.proposed_qty}，可售 ${fmtDays(i.days_before)}→${fmtDays(i.days_after)} 天`),
  ];
  return { send: true, title, card, lines, plan_id: plan.id, items: items.length };
}

// ── 入口 ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(b.action ?? "overview");
    let who = "cron";
    const isCron = await cronAuthed(req);
    if (!(isCron && CRON_ACTIONS.has(action))) who = (await verifyPasscode(req, TAB)).name;
    const db = admin();
    switch (action) {
      case "overview": return json(await overview());
      case "save_settings": {
        const keys = ["window_days", "min_days", "min_qty", "reserve_per_sku", "zero_sale_qty", "cn_min_days", "cn_target_days", "stock_max_age_hours"];
        const patch: Record<string, unknown> = { updated_at: nowIso() };
        for (const k of keys) if (b[k] !== undefined && b[k] !== "") {
          const v = Number(b[k]);
          if (!Number.isFinite(v) || v < 0) bad(`${k} 不合法`);
          patch[k] = v;
        }
        const { error } = await db.from("sea_inv_settings").update(patch).eq("id", 1);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_warehouse": {
        const code = String(b.code ?? "");
        if (!code) bad("code 必填");
        const patch: Record<string, unknown> = { updated_at: nowIso() };
        for (const k of ["name", "status", "provider_ref", "note", "region", "drive_folder", "drive_name_pattern"]) if (b[k] !== undefined) patch[k] = b[k] === "" ? null : b[k];
        if (b.file_config !== undefined) {
          const fc = (b.file_config ?? {}) as Record<string, unknown>;
          patch.file_config = Object.fromEntries(["sheet", "sku_col", "avail_col", "onhand_col", "name_col", "warehouse_col", "warehouse_value"]
            .filter((k) => String(fc[k] ?? "").trim()).map((k) => [k, String(fc[k]).trim()]));
        }
        if (b.links !== undefined) {
          const links = (Array.isArray(b.links) ? b.links : []).map((l: Record<string, unknown>) => ({ shop_id: String(l.shop_id ?? ""), tts_warehouse_id: String(l.tts_warehouse_id ?? "") }))
            .filter((l) => l.shop_id && l.tts_warehouse_id);
          patch.links = links;
        }
        const { error } = await db.from("sea_inv_warehouses").update(patch).eq("code", code);
        if (error) throw error;
        return json({ ok: true });
      }
      case "shop_warehouses": {
        const shop = await loadShop(String(b.shop_id ?? ""));
        const r = await ttsCall<{ warehouses?: unknown[] }>({ method: "GET", path: "/logistics/202309/warehouses", accessToken: shop.access_token, shopCipher: shop.shop_cipher });
        if (r.code !== 0) bad(apiErr("warehouses", r));
        return json({ warehouses: r.data?.warehouses ?? [] });
      }
      case "import_stock": return json(await importStock(b));
      case "sync_warehouse": return json(await syncWarehouse(String(b.code ?? ""), !!b.force));
      case "drive_preview": return json(await drivePreview(b));
      case "provider_warehouses": return json(await providerWarehouses(String(b.code ?? "")));
      case "sync_shop": return json(await syncShop(b));
      case "refresh_map": return json(await refreshMap());
      case "set_override": {
        const { error } = await db.from("sea_inv_sku_map").update({ wh_sku_override: normSku(b.wh_sku as string) || null, changed_at: nowIso() })
          .eq("shop_id", String(b.shop_id ?? "")).eq("sku_id", String(b.sku_id ?? ""));
        if (error) throw error;
        return json({ ok: true });
      }
      case "map_list": {
        const map = (await allMap()).filter((r) => b.include_inactive || r.active);
        const slots = await allSlots();
        const per = new Map<string, Slot[]>();
        for (const s of slots) per.set(`${s.shop_id}|${s.sku_id}`, [...(per.get(`${s.shop_id}|${s.sku_id}`) ?? []), s]);
        return json({ rows: map.map((r) => ({ ...r, slots: (per.get(`${r.shop_id}|${r.sku_id}`) ?? []).map((s) => ({ tts_warehouse_id: s.tts_warehouse_id, qty: s.qty, sold: s.sold, title: s.title })) })) });
      }
      case "stock_list": {
        const { data, error } = await db.from("sea_inv_wh_stock").select("*").eq("warehouse_code", String(b.warehouse_code ?? "")).order("wh_sku").limit(5000);
        if (error) throw error;
        return json({ rows: data ?? [] });
      }
      case "build_plan": return json(await buildPlan({ ...b, source: isCron ? "CRON" : "MANUAL" }, who));
      case "plan_get": return json(await planGet(b));
      case "plan_update": return json(await planUpdate(b));
      case "execute": return json(await execute(b, who));
      case "build_message": return json(await buildMessage(b));
      default: bad(`未知 action：${action}`);
    }
  } catch (e) {
    const err = e as Error & { status?: number };
    console.error("[sea-inventory]", err.message);
    return json({ error: err.message }, err.status ?? 500);
  }
});
