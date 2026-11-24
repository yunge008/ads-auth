// GMV Max 写操作（服务端路由版）：建组 + 店铺独占授权。
// 为什么不用 Edge Function：Lovable Cloud 部署 Edge Function 要耗积分，服务端路由随 main 同步免费上线。
// 逻辑与 supabase/functions/gmv-max-adgroup-batch-create 一致（两边改动需同步）。
import process from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const TT = "https://business-api.tiktok.com/open_api/v1.3";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Conn = { access_token: string; advertiser_ids: string[]; bc_id: string | null };

export function adminDb(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function tt(token: string, path: string, init: { method: "GET" | "POST"; params?: Record<string, string>; body?: unknown }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = new URL(`${TT}${path}`);
    for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
    let json: Record<string, unknown> = {};
    try {
      const r = await fetch(url, {
        method: init.method,
        headers: { "Access-Token": token, "Content-Type": "application/json" },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (e) {
      // 写操作网络失败不重试（可能已成功），读操作重试
      if (init.method === "POST" || attempt === 3) throw new Error(`${path}: network ${(e as Error).message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (json.code === 0) return (json.data ?? {}) as Record<string, unknown>;
    const msg = String(json.message ?? "");
    const limited = /too many requests|frequent/i.test(msg) || json.code === 40100 || json.code === 50002;
    if (limited && attempt < 3) { await sleep(3000 * 2 ** attempt); continue; }
    throw new Error(`${path}: ${msg || "unknown"} (code ${json.code ?? "?"})`);
  }
  throw new Error(`${path}: max retries`);
}

function genRequestId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 900000 + 100000)}`; // 19 位，< int64 上限
}

// preferBc：指定店铺授权 BC（同一广告户挂在多个授权连接下时用），对应连接的 token 排最前。
async function loadAdv(db: SupabaseClient, advertiserId: string, preferBc?: string) {
  const [{ data: shop, error: e1 }, { data: conns, error: e2 }] = await Promise.all([
    db.from("advertiser_countries").select("shop_id").eq("advertiser_id", advertiserId).maybeSingle(),
    db.from("tiktok_connections").select("access_token, advertiser_ids, bc_id, created_at").contains("advertiser_ids", [advertiserId]),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  // 默认授权时间最新的连接在前（切户后 BC 可能换成新授权的那个）
  let list = ((conns ?? []) as (Conn & { created_at?: string })[])
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))) as Conn[];
  if (preferBc) list = [...list.filter((c) => c.bc_id === preferBc), ...list.filter((c) => c.bc_id !== preferBc)];
  return {
    storeId: (shop?.shop_id as string | null) ?? null,
    conns: list,
    bcId: preferBc || (list.find((c) => c.bc_id)?.bc_id ?? null),
  };
}

// 依次尝试该户的每个授权 token（有的 token 缺写权限 40001）
async function withConns<T>(conns: Conn[], fn: (token: string) => Promise<T>): Promise<T> {
  if (!conns.length) throw new Error("该广告户没有可用的 TikTok 授权");
  let last: Error | null = null;
  for (const c of conns) {
    try { return await fn(c.access_token); } catch (e) {
      last = e as Error;
      if (!/40001|permission/i.test(last.message)) throw last;
    }
  }
  throw last ?? new Error("调用失败");
}

const IDENTITY_KEYS = ["identity_id", "identity_type", "identity_authorized_bc_id", "identity_authorized_shop_id", "store_id"];
function cleanIdentityList(v: unknown): Record<string, string>[] {
  if (!Array.isArray(v)) return [];
  const out: Record<string, string>[] = [];
  for (const it of v) {
    if (!it || typeof it !== "object") continue;
    const src = it as Record<string, unknown>;
    const o: Record<string, string> = {};
    for (const k of IDENTITY_KEYS) if (src[k] != null && src[k] !== "") o[k] = String(src[k]);
    if (o.identity_id && o.identity_type) out.push(o);
  }
  return out;
}

// 目标户可用的视频账号（/gmv_max/identity/get/）。BC_AUTH_TT 建组必须带 identity_authorized_shop_id，
// 而 /campaign/gmv_max/info/ 不返回它，只能从这里补。按 advertiser 缓存 10 分钟（批量逐行调用时省请求）。
type IdentityInfo = Record<string, unknown>;
const identityCache = new Map<string, { at: number; byId: Map<string, IdentityInfo> }>();
async function targetIdentities(conns: Conn[], advertiserId: string, storeId: string, bcIds: string[]) {
  const key = `${advertiserId}:${storeId}:${bcIds.join(",")}`;
  const hit = identityCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.byId;
  const byId = new Map<string, IdentityInfo>();
  // 实测必填 store_authorized_bc_id，且返回范围随它变化：目标户连接 BC 与源账号所属 BC 可能不同，逐个查后合并
  const errors: string[] = [];
  for (const bc of bcIds) {
    try {
      // 每个 BC 优先用它自己授权连接的 token 查（别的连接 token 可能对该 BC 无权限，查回空）
      const ordered = [...conns.filter((c) => c.bc_id === bc), ...conns.filter((c) => c.bc_id !== bc)];
      await withConns(ordered, async (token) => {
        const base = { advertiser_id: advertiserId, store_id: storeId, store_authorized_bc_id: bc };
        const add = (d: Record<string, unknown>) => {
          const list = (d.identity_list ?? d.list ?? []) as IdentityInfo[];
          for (const it of list) if (it.identity_id != null && !byId.has(String(it.identity_id))) byId.set(String(it.identity_id), it);
        };
        const data = await tt(token, "/gmv_max/identity/get/", { method: "GET", params: base });
        add(data);
        const pi = (data.page_info ?? {}) as Record<string, unknown>;
        const totalPage = Math.min(20, Number(pi.total_page ?? 1) || 1);
        for (let page = 2; page <= totalPage; page++) {
          add(await tt(token, "/gmv_max/identity/get/", {
            method: "GET",
            params: { ...base, page: String(page), ...(pi.page_size ? { page_size: String(pi.page_size) } : {}) },
          }));
        }
      });
    } catch (e) {
      errors.push(`BC ${bc}: ${(e as Error).message}`);
    }
  }
  if (!byId.size && errors.length) throw new Error(errors.join("；"));
  identityCache.set(key, { at: Date.now(), byId });
  return byId;
}

// 店铺商品状态（/store/product/get/，ad_creation_eligible=GMV_MAX）：status（AVAILABLE 才能投）、gmv_max_ads_status（OCCUPIED=已在启用中的 GMV Max 组）。
// 参数按文档描述推断（bc_id/store_id/advertiser_id/filtering/page/page_size），未逐字核验。缓存 10 分钟。
export type StoreProduct = { item_group_id: string; title?: string; status?: string; gmv_max_ads_status?: string };
const productCache = new Map<string, { at: number; byId: Map<string, StoreProduct> }>();
export async function storeProducts(conns: Conn[], advertiserId: string, storeId: string, bcId: string, fresh = false) {
  const key = `${advertiserId}:${storeId}:${bcId}`;
  const hit = productCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 600_000) return hit.byId;
  const byId = new Map<string, StoreProduct>();
  await withConns(conns, async (token) => {
    for (let page = 1; page <= 50; page++) {
      const data = await tt(token, "/store/product/get/", {
        method: "GET",
        params: {
          bc_id: bcId, store_id: storeId, advertiser_id: advertiserId,
          filtering: JSON.stringify({ ad_creation_eligible: "GMV_MAX" }),
          page: String(page), page_size: "100",
        },
      });
      const list = (data.store_products ?? data.products ?? data.list ?? []) as Record<string, unknown>[];
      for (const p of list) {
        const id = String(p.item_group_id ?? p.spu_id ?? "");
        if (!id) continue;
        byId.set(id, {
          item_group_id: id,
          title: p.title != null ? String(p.title) : undefined,
          status: p.status != null ? String(p.status) : undefined,
          gmv_max_ads_status: p.gmv_max_ads_status != null ? String(p.gmv_max_ads_status) : undefined,
        });
      }
      const pi = (data.page_info ?? {}) as Record<string, unknown>;
      const totalPage = Number(pi.total_page ?? 0);
      if (!list.length || !totalPage || page >= totalPage) break;
    }
  });
  productCache.set(key, { at: Date.now(), byId });
  return byId;
}

// 近 N 天消耗（按 广告组×商品），日期按 UTC+8 自然日（PH/MY/TH/北京同为 UTC+8；其他时区站点会有偏差）
export async function spendReport(db: SupabaseClient, advertiserId: string, days: number) {
  const { storeId, conns } = await loadAdv(db, advertiserId);
  if (!storeId) throw new Error(`广告户 ${advertiserId} 未配置店铺 ID`);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date(Date.now() + 8 * 3600_000);
  const end = fmt(now);
  const start = fmt(new Date(now.getTime() - (Math.max(1, days) - 1) * 86400_000));
  const campaigns: Record<string, number> = {};
  const products: Record<string, Record<string, number>> = {};
  await withConns(conns, async (token) => {
    for (let page = 1; page <= 50; page++) {
      const data = await tt(token, "/gmv_max/report/get/", {
        method: "GET",
        params: {
          advertiser_id: advertiserId, store_ids: JSON.stringify([storeId]),
          // 实测：带 item_group_id 维度时必须用 campaign_id 过滤，筛选只需组级消耗 → 只按 campaign_id 查
          dimensions: JSON.stringify(["campaign_id"]), metrics: JSON.stringify(["cost"]),
          start_date: start, end_date: end, page: String(page), page_size: "1000", filtering: "{}",
        },
      });
      const list = (data.list ?? []) as Record<string, Record<string, unknown>>[];
      for (const row of list) {
        const c = String(row.dimensions?.campaign_id ?? "");
        const it = String(row.dimensions?.item_group_id ?? "");
        const cost = Number(row.metrics?.cost ?? 0) || 0;
        if (!c) continue;
        campaigns[c] = (campaigns[c] ?? 0) + cost;
        if (it) (products[c] ??= {})[it] = ((products[c] ??= {})[it] ?? 0) + cost;
      }
      const pi = (data.page_info ?? {}) as Record<string, unknown>;
      const totalPage = Number(pi.total_page ?? 0);
      if (!list.length || !totalPage || page >= totalPage) break;
    }
  });
  return { start, end, campaigns, products };
}

// 某个广告组近 N 天有数据的商品（全店组 ALL 没有 item_group_ids，只能从报表取它实际投到的商品）。
// 商品维度必须带 campaign_id 过滤（实测 40002）；过滤字段名 campaign_ids 按报错提示推断，未核验。
export async function campaignProducts(db: SupabaseClient, advertiserId: string, campaignId: string, days: number) {
  const { storeId, conns } = await loadAdv(db, advertiserId);
  if (!storeId) throw new Error(`广告户 ${advertiserId} 未配置店铺 ID`);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date(Date.now() + 8 * 3600_000);
  const end = fmt(now);
  const start = fmt(new Date(now.getTime() - (Math.max(1, days) - 1) * 86400_000));
  const products: Record<string, number> = {};
  await withConns(conns, async (token) => {
    for (let page = 1; page <= 20; page++) {
      const data = await tt(token, "/gmv_max/report/get/", {
        method: "GET",
        params: {
          advertiser_id: advertiserId, store_ids: JSON.stringify([storeId]),
          dimensions: JSON.stringify(["campaign_id", "item_group_id"]), metrics: JSON.stringify(["cost"]),
          start_date: start, end_date: end, page: String(page), page_size: "1000",
          filtering: JSON.stringify({ campaign_ids: [campaignId] }),
        },
      });
      const list = (data.list ?? []) as Record<string, Record<string, unknown>>[];
      for (const row of list) {
        if (String(row.dimensions?.campaign_id ?? "") !== campaignId) continue;
        const it = String(row.dimensions?.item_group_id ?? "");
        if (it) products[it] = (products[it] ?? 0) + (Number(row.metrics?.cost ?? 0) || 0);
      }
      const pi = (data.page_info ?? {}) as Record<string, unknown>;
      const totalPage = Number(pi.total_page ?? 0);
      if (!list.length || !totalPage || page >= totalPage) break;
    }
  });
  return { start, end, products };
}

// 店铺商品清单（含是否在 GMV Max 组内），给页面下载「未在广告组的商品」
export async function listStoreProducts(db: SupabaseClient, advertiserId: string, preferBc?: string) {
  const { storeId, conns, bcId } = await loadAdv(db, advertiserId, preferBc);
  if (!storeId || !bcId) throw new Error(`广告户 ${advertiserId} 缺店铺 ID 或 BC`);
  const m = await storeProducts(conns, advertiserId, storeId, bcId, true);
  return { store_id: storeId, bc_id: bcId, products: Array.from(m.values()) };
}

export type CreateRow = {
  advertiser_id?: unknown; campaign_name?: unknown; item_group_ids?: unknown; roas_bid?: unknown; budget?: unknown;
  start_time?: unknown; end_time?: unknown; identity_list?: unknown; affiliate_posts_enabled?: unknown;
  accelerate_testing_for_new_videos?: unknown;
  store_authorized_bc_id?: unknown;
};
// ok=true 且 partial=true：组已建，但没能与源组完全一致（notes 说明差异），需人工处理
// products：逐个商品的结果（成功 / 失败 / 组成功商品未纳入 + 原因），给结果表「商品明细」与导入记录用
export type ProductStatus = "成功" | "失败" | "组成功商品未纳入";
export type ProductResult = { item_group_id: string; status: ProductStatus; reason: string };
export type CreateResult = {
  ok: boolean; partial?: boolean; campaign_id?: string; error?: string; notes?: string[]; products?: ProductResult[];
};
type Ctx = { excluded: Map<string, string>; occupied: Set<string> };

export async function createOne(db: SupabaseClient, r: CreateRow): Promise<CreateResult> {
  const ids = (Array.isArray(r.item_group_ids) ? r.item_group_ids : []).map((x) => String(x).trim()).filter(Boolean);
  const ctx: Ctx = { excluded: new Map(), occupied: new Set() };
  let res: CreateResult;
  try {
    res = await createCore(db, r, ctx);
  } catch (e) {
    res = { ok: false, error: (e as Error).message };
  }
  const products: ProductResult[] = ids.map((id) => {
    if (!res.ok) {
      if (ctx.occupied.has(id)) return { item_group_id: id, status: "失败", reason: "已在其他启用中的 GMV Max 组内" };
      if (ctx.occupied.size) return { item_group_id: id, status: "失败", reason: "同组其他商品已在其他组内，整组未建" };
      if (ctx.excluded.has(id)) return { item_group_id: id, status: "失败", reason: ctx.excluded.get(id)! };
      return { item_group_id: id, status: "失败", reason: res.error ?? "建组失败" };
    }
    if (ctx.excluded.has(id)) return { item_group_id: id, status: "组成功商品未纳入", reason: ctx.excluded.get(id)! };
    return { item_group_id: id, status: "成功", reason: "" };
  });
  return { ...res, products };
}

const pad = (n: number) => String(n).padStart(2, "0");
function nowPlus5Utc(): string {
  const d = new Date(Date.now() + 5 * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

// 单行建组。不传 promotion_days / auto_budget（默认关；传 promotion_days 对象会被自动置 is_enabled=true）。
async function createCore(db: SupabaseClient, r: CreateRow, ctx: Ctx): Promise<CreateResult> {
  const advertiserId = String(r.advertiser_id ?? "").trim();
  const name = String(r.campaign_name ?? "").trim();
  const ids = (Array.isArray(r.item_group_ids) ? r.item_group_ids : []).map((x) => String(x).trim()).filter(Boolean);
  const roas = Number(r.roas_bid);
  const budget = Number(r.budget);
  if (!/^\d+$/.test(advertiserId)) return { ok: false, error: "advertiser_id 必填" };
  if (!name) return { ok: false, error: "campaign_name 必填" };
  if (!ids.length) return { ok: false, error: "商品ID 至少一个（全店商品填 ALL）" };
  // 商品ID 只填 ALL = 全店商品组（product_specific_type=ALL，不传 item_group_ids）
  const allProducts = ids.length === 1 && ids[0].toUpperCase() === "ALL";
  if (!(roas > 0)) return { ok: false, error: "ROI 必须大于 0" };
  if (!(budget > 0)) return { ok: false, error: "预算必须大于 0" };

  const preferBc = String(r.store_authorized_bc_id ?? "").trim();
  if (preferBc && !/^\d+$/.test(preferBc)) return { ok: false, error: "店铺授权BC 只能是数字" };
  const { storeId, conns, bcId } = await loadAdv(db, advertiserId, preferBc || undefined);
  if (!storeId) return { ok: false, error: `广告户 ${advertiserId} 未配置店铺 ID（设置页 → 店铺ID）` };
  if (!bcId) return { ok: false, error: `广告户 ${advertiserId} 找不到 BC ID` };

  // 商品预检：不可用（下架/删除/不可投）的去掉并在备注列出；被启用中的组占用的 → 整行失败（说明已有组在投，避免拆出半重复组）
  const preNotes: string[] = [];
  let useIds = ids;
  if (!(ids.length === 1 && ids[0].toUpperCase() === "ALL")) {
    try {
      const catalog = await storeProducts(conns, advertiserId, storeId, bcId);
      if (catalog.size) {
        const occupied = ids.filter((id) => catalog.get(id)?.gmv_max_ads_status === "OCCUPIED");
        if (occupied.length) {
          for (const id of occupied) ctx.occupied.add(id);
          return { ok: false, error: `商品已在启用中的 GMV Max 组里（目标户可能已建过此组）：${occupied.join(",")}` };
        }
        // 查不到 = 不在「可建 GMV Max」商品目录里（通常已下架/删除）；查到但 status≠AVAILABLE = 不可投
        const notFound = ids.filter((id) => !catalog.has(id));
        const badStatus = ids.filter((id) => { const p = catalog.get(id); return !!p && p.status != null && p.status !== "AVAILABLE"; });
        const unavailable = [...notFound, ...badStatus];
        if (unavailable.length) {
          useIds = ids.filter((id) => !unavailable.includes(id));
          for (const id of notFound) ctx.excluded.set(id, "不可用：店铺可投商品目录查不到（多为下架/删除）");
          for (const id of badStatus) ctx.excluded.set(id, `不可用：商品状态 ${catalog.get(id)?.status}`);
          const detail = [
            notFound.length ? `店铺可投目录查不到 ${notFound.length} 个：${notFound.join(",")}` : "",
            badStatus.length ? `状态不可投 ${badStatus.length} 个：${badStatus.map((id) => `${id}(${catalog.get(id)?.status})`).join(",")}` : "",
          ].filter(Boolean).join("；");
          if (!useIds.length) return { ok: false, error: `全部商品不可投：${detail}` };
          preNotes.push(`去掉不可投商品 ${unavailable.length} 个（${detail}）`);
        }
      }
    } catch (e) {
      // 授权缺 /store/product/get/ 权限（40001）是长期状态，不算异常，不写备注；其他错误才提示
      const m = (e as Error).message;
      if (!/40001|permission/i.test(m)) preNotes.push(`商品预检失败：${m}`);
    }
  }

  const endTime = String(r.end_time ?? "").trim();
  const body: Record<string, unknown> = {
    advertiser_id: advertiserId,
    campaign_name: name,
    store_id: storeId,
    store_authorized_bc_id: bcId,
    shopping_ads_type: "PRODUCT",
    product_specific_type: allProducts ? "ALL" : "CUSTOMIZED_PRODUCTS",
    ...(allProducts ? {} : { item_group_ids: useIds }),
    optimization_goal: "VALUE",
    deep_bid_type: "VO_MIN_ROAS",
    roas_bid: roas,
    budget,
    schedule_type: endTime ? "SCHEDULE_START_END" : "SCHEDULE_FROM_NOW",
    schedule_start_time: String(r.start_time ?? "").trim() || nowPlus5Utc(),
    product_video_specific_type: "AUTO_SELECTION",
  };
  if (endTime) body.schedule_end_time = endTime;
  // 视频账号与源组完全一致（后台可选 23 个，负责人确认），不截断；接口若拒收超量则整行失败，不擅自去掉。
  const identityList = cleanIdentityList(r.identity_list);
  if (identityList.length) body.identity_list = identityList;
  // 用目标户 identity/get 补 identity_authorized_shop_id / identity_authorized_bc_id；目标户查不到的账号直接报错，不擅自去掉
  if (identityList.length) {
    let avail: Map<string, IdentityInfo>;
    try {
      avail = await targetIdentities(conns, advertiserId, storeId,
        Array.from(new Set([bcId, ...identityList.map((x) => x.identity_authorized_bc_id).filter(Boolean)])));
    } catch (e) {
      return { ok: false, error: `查询目标户视频账号失败：${(e as Error).message}` };
    }
    const missing: string[] = [];
    const unavailable: string[] = [];
    for (const x of identityList) {
      const t = avail.get(x.identity_id);
      if (!t) { missing.push(x.identity_id); continue; }
      if (t.product_gmv_max_available === false) unavailable.push(x.identity_id);
      for (const k of ["identity_authorized_shop_id", "identity_authorized_bc_id", "store_id"]) {
        if (t[k] != null && t[k] !== "" && !x[k]) x[k] = String(t[k]);
      }
    }
    if (missing.length || unavailable.length) {
      return {
        ok: false,
        error: [
          missing.length ? `目标户查不到这些视频账号：${missing.join(",")}（已查 BC：${Array.from(new Set([bcId, ...identityList.map((x) => x.identity_authorized_bc_id).filter(Boolean)])).join(",")}）` : "",
          unavailable.length ? `目标户这些视频账号不可用于商品 GMV Max：${unavailable.join(",")}` : "",
        ].filter(Boolean).join("；") + "（未建组，避免与原组不一致）",
      };
    }
  }
  if (typeof r.affiliate_posts_enabled === "boolean") body.affiliate_posts_enabled = r.affiliate_posts_enabled;
  const accel = r.accelerate_testing_for_new_videos;
  if (accel === "ON" || accel === "OFF") body.accelerate_testing_for_new_videos = accel;

  // 先按源组原样建；商品 >50 被拒时降到 50 个建组，再用 update 补全到与源组一致。
  const fullIds = useIds;
  const notes: string[] = [...preNotes];
  let lastErr = "";
  let campaignId: string | undefined;
  let trimmedIds = false;
  for (let attempt = 0; attempt < 4 && !campaignId; attempt++) {
    try {
      const data = await withConns(conns, (token) =>
        tt(token, "/campaign/gmv_max/create/", { method: "POST", body: { ...body, request_id: genRequestId() } }));
      campaignId = data.campaign_id ? String(data.campaign_id) : undefined;
      if (!campaignId) return { ok: false, error: "建组返回无 campaign_id" };
    } catch (e) {
      lastErr = (e as Error).message;
      const curIds = (body.item_group_ids as string[] | undefined) ?? [];
      if ("accelerate_testing_for_new_videos" in body && /accelerate/i.test(lastErr)) {
        delete body.accelerate_testing_for_new_videos;
        notes.push("接口不收「新素材优先测试」，需后台手动开");
      } else if (curIds.length > 50 && !trimmedIds) {
        body.item_group_ids = curIds.slice(0, 50);
        trimmedIds = true;
      } else break;
    }
  }
  // 补全：update 参数（advertiser_id / campaign_id + 要改的字段）按 create 惯例推断，未见文档。
  const update = async (patch: Record<string, unknown>) =>
    withConns(conns, (token) => tt(token, "/campaign/gmv_max/update/", {
      method: "POST", body: { advertiser_id: advertiserId, campaign_id: campaignId, ...patch },
    }));
  const UNAVAILABLE = /unavailable/i;
  const rejectReason = (msg: string) => `不可用（TikTok 拒绝：${msg.replace(/^.*?: /, "")}）`;

  // TikTok 报 product is unavailable 且无法预检时：让 TikTok 自己逐个判。
  // ① 逐个商品单独试建（失败不会建出任何组）直到一个成功作为种子；② 其余分批 update 追加，某批失败就二分，定位到单个被拒商品。
  let isolated = false;
  if (!campaignId && UNAVAILABLE.test(lastErr) && !allProducts && fullIds.length > 1) {
    isolated = true;
    trimmedIds = false;
    let seedIdx = -1;
    for (let k = 0; k < fullIds.length && k < 40; k++) {
      try {
        const data = await withConns(conns, (token) => tt(token, "/campaign/gmv_max/create/", {
          method: "POST", body: { ...body, item_group_ids: [fullIds[k]], request_id: genRequestId() },
        }));
        campaignId = data.campaign_id ? String(data.campaign_id) : undefined;
        if (campaignId) { seedIdx = k; break; }
      } catch (e) {
        const m = (e as Error).message;
        if (!UNAVAILABLE.test(m)) { lastErr = m; break; } // 非商品原因（如 identity/预算）→ 不再逐个试
        ctx.excluded.set(fullIds[k], rejectReason(m));
      }
    }
    if (campaignId) {
      let current = [fullIds[seedIdx]];
      const tryAdd = async (list: string[]): Promise<void> => {
        if (!list.length) return;
        try {
          await update({ item_group_ids: [...current, ...list] });
          current = [...current, ...list];
        } catch (e) {
          let m = (e as Error).message;
          // 实测 PH 大组4：刚改过的组紧接着再 update 也会报 unavailable（被拒商品成片连续、间隔性成功）→ 等 4 秒原样重试一次再判
          if (UNAVAILABLE.test(m)) {
            await sleep(4000);
            try {
              await update({ item_group_ids: [...current, ...list] });
              current = [...current, ...list];
              return;
            } catch (e2) {
              m = (e2 as Error).message;
            }
          }
          if (list.length === 1) { ctx.excluded.set(list[0], UNAVAILABLE.test(m) ? rejectReason(m) : `补全失败：${m}`); return; }
          const mid = Math.ceil(list.length / 2);
          await tryAdd(list.slice(0, mid));
          await tryAdd(list.slice(mid));
        }
      };
      const rest = fullIds.slice(seedIdx + 1);
      for (let k = 0; k < rest.length; k += 25) await tryAdd(rest.slice(k, k + 25));
      const rejected = fullIds.filter((id) => ctx.excluded.has(id));
      notes.push(`TikTok 报商品不可用，逐个定位：纳入 ${current.length}/${fullIds.length}${rejected.length ? `，被拒 ${rejected.length} 个：${rejected.join(",")}` : ""}`);
    }
  }
  if (!campaignId) return { ok: false, error: notes.length ? `${lastErr}｜${notes.join("；")}` : lastErr };

  let partial = notes.some((n) => n.includes("需后台手动开") || n.includes("去掉不可投商品")) ||
    (isolated && fullIds.some((id) => ctx.excluded.has(id)));
  if (trimmedIds) {
    try {
      await update({ item_group_ids: fullIds });
      notes.push(`商品先建 50 个，已补全到 ${fullIds.length} 个`);
    } catch (e) {
      partial = true;
      notes.push(`商品只建了 50/${fullIds.length} 个，补全失败：${(e as Error).message}；未加入的商品：${fullIds.slice(50).join(",")}`);
      for (const id of fullIds.slice(50)) ctx.excluded.set(id, `补全失败：${(e as Error).message}`);
    }
  }
  return { ok: true, campaign_id: campaignId, ...(partial ? { partial: true } : {}), ...(notes.length ? { notes } : {}) };
}

// 读取源户 Product GMV Max 广告组 + 逐个 info（替代 Edge Function gmv-max-campaign-info，以便按指定 BC 的授权连接读取）。
// 用户实测：不同 BC 授权读到的视频账号集合不同，用导入目标 BC 的连接读，视频账号才与目标户可用集合一致。
// Cloudflare Worker 单请求子请求数有限，limit 上限 20。
export async function campaignInfo(db: SupabaseClient, advertiserId: string, preferBc: string | undefined, offset: number, limit: number) {
  if (!/^\d+$/.test(advertiserId)) throw new Error("advertiser_id 必填");
  const { conns } = await loadAdv(db, advertiserId, preferBc);
  const lim = Math.min(20, Math.max(1, limit || 20));
  return withConns(conns, async (token) => {
    const campaigns: { campaign_id: string; campaign_name: string; operation_status: string }[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 50; page++) {
      const data = await tt(token, "/gmv_max/campaign/get/", {
        method: "GET",
        params: {
          advertiser_id: advertiserId, page: String(page), page_size: "100",
          filtering: JSON.stringify({ gmv_max_promotion_types: ["PRODUCT_GMV_MAX"] }),
        },
      });
      const list = (data.list ?? []) as Record<string, unknown>[];
      for (const r of list) {
        const id = String(r.campaign_id ?? r.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        campaigns.push({ campaign_id: id, campaign_name: String(r.campaign_name ?? ""), operation_status: String(r.operation_status ?? "") });
      }
      const pi = (data.page_info ?? {}) as Record<string, unknown>;
      const totalPage = Number(pi.total_page ?? 0);
      if (!list.length || !totalPage || page >= totalPage) break;
    }
    const slice = campaigns.slice(offset, offset + lim);
    const infos: { campaign_id: string; ok: boolean; info?: unknown; error?: string }[] = [];
    for (const c of slice) {
      try {
        infos.push({ campaign_id: c.campaign_id, ok: true, info: await tt(token, "/campaign/gmv_max/info/", {
          method: "GET", params: { advertiser_id: advertiserId, campaign_id: c.campaign_id },
        }) });
      } catch (e) {
        infos.push({ campaign_id: c.campaign_id, ok: false, error: (e as Error).message });
      }
    }
    const next = offset + slice.length;
    return { campaigns, infos, next_offset: next < campaigns.length ? next : null };
  });
}

// 授权回调用：用刚换到的 access_token 查它可访问的 BC 列表（/bc/get/ 不带 bc_ids），授权未返回 bc_id 时让用户选
export async function bcListForToken(accessToken: string) {
  const data = await tt(accessToken, "/bc/get/", { method: "GET", params: { page: "1", page_size: "50" } });
  const list = (data.list ?? []) as Record<string, unknown>[];
  return list.map((x) => {
    const info = (x.bc_info ?? x) as Record<string, unknown>;
    return { bc_id: String(info.bc_id ?? ""), bc_name: String(info.name ?? info.bc_name ?? "") };
  }).filter((b) => b.bc_id);
}

// 导入记录：每个商品一行写 gmv_max_import_logs（表由 migration 20261124120000 创建；表不存在时不影响建组）
export type LogMeta = { batch_id?: unknown; source?: unknown; kind?: unknown; source_campaign_id?: unknown };
export async function logImport(db: SupabaseClient, meta: LogMeta, row: CreateRow, res: CreateResult, operator: string) {
  const batchId = String(meta.batch_id ?? "").trim();
  if (!batchId) return null;
  const base = {
    batch_id: batchId,
    kind: String(meta.kind ?? "excel"),
    source: String(meta.source ?? ""),
    operator,
    advertiser_id: String(row.advertiser_id ?? ""),
    bc_id: String(row.store_authorized_bc_id ?? ""),
    campaign_name: String(row.campaign_name ?? ""),
    source_campaign_id: String(meta.source_campaign_id ?? ""),
    new_campaign_id: res.campaign_id ?? null,
    group_status: res.ok ? (res.partial ? "已建·需处理" : "成功") : "失败",
    group_note: res.ok ? (res.notes ?? []).join("；") : (res.error ?? ""),
  };
  const products = res.products?.length ? res.products : [{ item_group_id: "", status: res.ok ? "成功" : "失败", reason: res.error ?? "" }];
  const { error } = await db.from("gmv_max_import_logs").insert(
    products.map((p) => ({ ...base, item_group_id: p.item_group_id, status: p.status, reason: p.reason })),
  );
  return error ? error.message : null;
}

export async function listImportBatches(db: SupabaseClient, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out = new Map<string, { batch_id: string; kind: string; source: string; operator: string; advertiser_id: string;
    first_at: string; last_at: string; groups: Set<string>; counts: Record<string, number> }>();
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from("gmv_max_import_logs")
      .select("batch_id, kind, source, operator, advertiser_id, created_at, campaign_name, status")
      .gte("created_at", since).order("created_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    type LogRow = { batch_id: string; kind: string; source: string; operator: string; advertiser_id: string;
      created_at: string; campaign_name: string; status: string };
    for (const r of (data ?? []) as unknown as LogRow[]) {
      const b = out.get(r.batch_id) ?? { batch_id: r.batch_id, kind: r.kind, source: r.source, operator: r.operator,
        advertiser_id: r.advertiser_id, first_at: r.created_at, last_at: r.created_at, groups: new Set<string>(), counts: {} };
      if (r.created_at < b.first_at) b.first_at = r.created_at;
      if (r.created_at > b.last_at) b.last_at = r.created_at;
      b.groups.add(r.campaign_name);
      b.counts[r.status] = (b.counts[r.status] ?? 0) + 1;
      out.set(r.batch_id, b);
    }
    if ((data ?? []).length < 1000) break;
  }
  return Array.from(out.values()).map((b) => ({ ...b, groups: b.groups.size, counts: b.counts as Record<string, number> }))
    .sort((a, b) => b.last_at.localeCompare(a.last_at));
}

export async function getImportBatch(db: SupabaseClient, batchId: string) {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from("gmv_max_import_logs").select("*").eq("batch_id", batchId)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

export async function exclusiveAuth(db: SupabaseClient, advertiserId: string, grant: boolean) {
  if (!/^\d+$/.test(advertiserId)) throw new Error("advertiser_id 必填");
  const { storeId, conns, bcId } = await loadAdv(db, advertiserId);
  const check = (token: string) => tt(token, "/gmv_max/store/list/", { method: "GET", params: { advertiser_id: advertiserId } }).then((data) => {
    const list = (data.store_list ?? data.list ?? []) as Record<string, unknown>[];
    const store = storeId ? list.find((s) => String(s.store_id ?? "") === storeId) : undefined;
    const h = (store?.exclusive_authorized_advertiser_info ?? null) as Record<string, unknown> | null;
    return {
      store_id: storeId,
      store_found: !!store,
      holder_advertiser_id: h?.advertiser_id != null ? String(h.advertiser_id) : null,
      holder_advertiser_name: h?.advertiser_name != null ? String(h.advertiser_name) : null,
      raw: data,
    };
  });
  return withConns(conns, async (token) => {
    if (!grant) return check(token);
    if (!storeId) throw new Error(`广告户 ${advertiserId} 未配置店铺 ID`);
    if (!bcId) throw new Error(`广告户 ${advertiserId} 找不到 BC ID`);
    // TikTok 报错要求 bc_id = 店铺所属（owner）商务中心。优先取 store/list 里该店铺的 BC 字段，取不到用连接表的 bc_id。
    const cur = await check(token);
    const store = ((cur.raw.store_list ?? cur.raw.list ?? []) as Record<string, unknown>[])
      .find((s) => String(s.store_id ?? "") === storeId) ?? {};
    const ownerBc = String(store.store_authorized_bc_id ?? store.bc_id ?? store.owner_bc_id
      ?? (store.store_authorized_bc_info as Record<string, unknown> | undefined)?.bc_id ?? bcId);
    const granted = await tt(token, "/gmv_max/exclusive_authorization/create/", {
      method: "POST",
      body: { advertiser_id: advertiserId, store_id: storeId, bc_id: ownerBc, store_authorized_bc_id: ownerBc },
    });
    return { granted, after: await check(token).catch((e) => ({ error: (e as Error).message })) };
  });
}

// 口令 + gmv-max-create 页面权限校验：借已部署的 gmv-max-campaign-info，传非法 advertiser_id，
// 它先做鉴权（401/403），通过后因参数非法直接 400 返回，不会调 TikTok。
export async function checkGmvMaxPasscode(request: Request): Promise<string | null> {
  const passcode = request.headers.get("x-admin-passcode") ?? "";
  if (!passcode) return "未登录";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/gmv-max-campaign-info`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "x-admin-passcode": passcode,
      "x-admin-name": request.headers.get("x-admin-name") ?? "",
    },
    body: JSON.stringify({ advertiser_id: "auth_check" }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (r.status === 400 && /advertiser_id/.test(j.error ?? "")) return null;
  return j.error ?? `鉴权失败 HTTP ${r.status}`;
}
