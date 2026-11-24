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
      await withConns(conns, async (token) => {
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

export type CreateRow = {
  advertiser_id?: unknown; campaign_name?: unknown; item_group_ids?: unknown; roas_bid?: unknown; budget?: unknown;
  start_time?: unknown; end_time?: unknown; identity_list?: unknown; affiliate_posts_enabled?: unknown;
  accelerate_testing_for_new_videos?: unknown;
  store_authorized_bc_id?: unknown;
};
// ok=true 且 partial=true：组已建，但没能与源组完全一致（notes 说明差异），需人工处理
export type CreateResult = { ok: boolean; partial?: boolean; campaign_id?: string; error?: string; notes?: string[] };

const pad = (n: number) => String(n).padStart(2, "0");
function nowPlus5Utc(): string {
  const d = new Date(Date.now() + 5 * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

// 单行建组。不传 promotion_days / auto_budget（默认关；传 promotion_days 对象会被自动置 is_enabled=true）。
export async function createOne(db: SupabaseClient, r: CreateRow): Promise<CreateResult> {
  const advertiserId = String(r.advertiser_id ?? "").trim();
  const name = String(r.campaign_name ?? "").trim();
  const ids = (Array.isArray(r.item_group_ids) ? r.item_group_ids : []).map((x) => String(x).trim()).filter(Boolean);
  const roas = Number(r.roas_bid);
  const budget = Number(r.budget);
  if (!/^\d+$/.test(advertiserId)) return { ok: false, error: "advertiser_id 必填" };
  if (!name) return { ok: false, error: "campaign_name 必填" };
  if (!ids.length) return { ok: false, error: "商品ID 至少一个" };
  if (!(roas > 0)) return { ok: false, error: "ROI 必须大于 0" };
  if (!(budget > 0)) return { ok: false, error: "预算必须大于 0" };

  const preferBc = String(r.store_authorized_bc_id ?? "").trim();
  if (preferBc && !/^\d+$/.test(preferBc)) return { ok: false, error: "店铺授权BC 只能是数字" };
  const { storeId, conns, bcId } = await loadAdv(db, advertiserId, preferBc || undefined);
  if (!storeId) return { ok: false, error: `广告户 ${advertiserId} 未配置店铺 ID（设置页 → 店铺ID）` };
  if (!bcId) return { ok: false, error: `广告户 ${advertiserId} 找不到 BC ID` };

  const endTime = String(r.end_time ?? "").trim();
  const body: Record<string, unknown> = {
    advertiser_id: advertiserId,
    campaign_name: name,
    store_id: storeId,
    store_authorized_bc_id: bcId,
    shopping_ads_type: "PRODUCT",
    product_specific_type: "CUSTOMIZED_PRODUCTS",
    item_group_ids: ids,
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
  const fullIds = ids;
  const notes: string[] = [];
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
      const curIds = body.item_group_ids as string[];
      if ("accelerate_testing_for_new_videos" in body && /accelerate/i.test(lastErr)) {
        delete body.accelerate_testing_for_new_videos;
        notes.push("接口不收「新素材优先测试」，需后台手动开");
      } else if (curIds.length > 50 && !trimmedIds) {
        body.item_group_ids = curIds.slice(0, 50);
        trimmedIds = true;
      } else break;
    }
  }
  if (!campaignId) return { ok: false, error: notes.length ? `${lastErr}｜${notes.join("；")}` : lastErr };

  // 补全：update 参数（advertiser_id / campaign_id + 要改的字段）按 create 惯例推断，未见文档。
  let partial = notes.some((n) => n.includes("需后台手动开"));
  const update = async (patch: Record<string, unknown>) =>
    withConns(conns, (token) => tt(token, "/campaign/gmv_max/update/", {
      method: "POST", body: { advertiser_id: advertiserId, campaign_id: campaignId, ...patch },
    }));
  if (trimmedIds) {
    try {
      await update({ item_group_ids: fullIds });
      notes.push(`商品先建 50 个，已补全到 ${fullIds.length} 个`);
    } catch (e) {
      partial = true;
      notes.push(`商品只建了 50/${fullIds.length} 个，补全失败：${(e as Error).message}；未加入的商品：${fullIds.slice(50).join(",")}`);
    }
  }
  return { ok: true, campaign_id: campaignId, ...(partial ? { partial: true } : {}), ...(notes.length ? { notes } : {}) };
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
