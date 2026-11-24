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

async function loadAdv(db: SupabaseClient, advertiserId: string) {
  const [{ data: shop, error: e1 }, { data: conns, error: e2 }] = await Promise.all([
    db.from("advertiser_countries").select("shop_id").eq("advertiser_id", advertiserId).maybeSingle(),
    db.from("tiktok_connections").select("access_token, advertiser_ids, bc_id").contains("advertiser_ids", [advertiserId]),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  const list = (conns ?? []) as Conn[];
  return { storeId: (shop?.shop_id as string | null) ?? null, conns: list, bcId: list.find((c) => c.bc_id)?.bc_id ?? null };
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

export type CreateRow = {
  advertiser_id?: unknown; campaign_name?: unknown; item_group_ids?: unknown; roas_bid?: unknown; budget?: unknown;
  start_time?: unknown; end_time?: unknown; identity_list?: unknown; affiliate_posts_enabled?: unknown;
  accelerate_testing_for_new_videos?: unknown;
};
export type CreateResult = { ok: boolean; campaign_id?: string; error?: string; notes?: string[] };

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
  if (ids.length > 50) return { ok: false, error: `商品 ${ids.length} 个，超过单组上限 50，不新建（请手动处理）` };
  if (!(roas > 0)) return { ok: false, error: "ROI 必须大于 0" };
  if (!(budget > 0)) return { ok: false, error: "预算必须大于 0" };

  const { storeId, conns, bcId } = await loadAdv(db, advertiserId);
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
  const identityList = cleanIdentityList(r.identity_list);
  if (identityList.length) body.identity_list = identityList;
  if (typeof r.affiliate_posts_enabled === "boolean") body.affiliate_posts_enabled = r.affiliate_posts_enabled;
  const accel = r.accelerate_testing_for_new_videos;
  if (accel === "ON" || accel === "OFF") body.accelerate_testing_for_new_videos = accel;

  const notes: string[] = [];
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await withConns(conns, (token) =>
        tt(token, "/campaign/gmv_max/create/", { method: "POST", body: { ...body, request_id: genRequestId() } }));
      return { ok: true, campaign_id: data.campaign_id ? String(data.campaign_id) : undefined, ...(notes.length ? { notes } : {}) };
    } catch (e) {
      lastErr = (e as Error).message;
      const il = body.identity_list as Record<string, string>[] | undefined;
      if ("accelerate_testing_for_new_videos" in body && /accelerate/i.test(lastErr)) {
        delete body.accelerate_testing_for_new_videos;
        notes.push("接口不收新素材优先测试，需后台手动开");
      } else if (il && il.length > 20) {
        const sorted = [...il.filter((x) => x.identity_type === "TTS_TT"), ...il.filter((x) => x.identity_type !== "TTS_TT")];
        body.identity_list = sorted.slice(0, 20);
        notes.push(`视频账号 ${il.length}→20，去掉：${sorted.slice(20).map((x) => x.identity_id).join(",")}`);
      } else break;
    }
  }
  return { ok: false, error: notes.length ? `${lastErr}｜${notes.join("；")}` : lastErr };
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
    // 参数按 create 接口惯例推断（advertiser_id / store_id / store_authorized_bc_id），未见文档
    const granted = await tt(token, "/gmv_max/exclusive_authorization/create/", {
      method: "POST",
      body: { advertiser_id: advertiserId, store_id: storeId, store_authorized_bc_id: bcId },
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
