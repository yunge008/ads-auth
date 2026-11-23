// TikTok Shop 商品上架（只写草稿）。供 tools/tts-listing（Claude / Codex 本地执行）和后续网页端调用。仅管理员。
//
// action：
//   shops                                   已授权店铺列表（不含 token）：shop_id / 名称 / 站点 / 卖家类型 / 授权 scope
//   prepare   {shop_id, category_id}        只读：仓库列表 + 类目规则 + 类目属性（含销售属性），建草稿前核对用
//   find_products {shop_id, seller_skus:[...], status?}   只读：按商家 SKU 搜商品（Search Products 202502）
//   product   {shop_id, product_id | product_ids[≤20], locale?=zh-CN}   只读：商品详情原始数据（Get Product 202309）
//   replicated {shop_id, product_id}        只读：源商品同步到其他站点后的各站点商品 ID（Get Global Replicated Products）
//   upload_image {shop_id, url, use_case?}  从公网 URL（TOS）取图 → Upload Product Image → 返回 TikTok 图片 uri/url
//             use_case：MAIN_IMAGE（默认）/ ATTRIBUTE_IMAGE / DESCRIPTION_IMAGE / SIZE_CHART_IMAGE
//   create_draft {shop_id, product, confirm:"DRAFT"}
//             Create Product（202309），函数内强制 save_mode=AS_DRAFT；SEA/US 强制 category_version=v2。
//             product 为官方请求体（title/description/category_id/brand_id/main_images/skus/package_*/product_attributes…）
//             建议带 idempotency_key（同一 listing 重试不会重复建）。
//
// 写接口只有「传图」和「建草稿」两个，经 _shared/tts.ts 闸门：Create Product 的 save_mode 不是 AS_DRAFT 一律拦截。
// 草稿需人工在 Seller Center → 商品 → 草稿 里检查后发布。
// 所需 Partner Center 权限包：Product Basic（传图/读类目）+ Product Modify（建商品）+ Logistics Basic（仓库）。
import { admin, requireAdmin } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttsCall, type TtsResult } from "../_shared/tts.ts";

type Shop = {
  shop_id: string;
  shop_cipher: string;
  shop_name: string | null;
  region: string | null;
  access_token: string;
  access_expires_at: string | null;
};

const V2_REGIONS = new Set(["US", "PH", "MY", "SG", "TH", "VN", "ID"]);
const USE_CASES = new Set(["MAIN_IMAGE", "ATTRIBUTE_IMAGE", "DESCRIPTION_IMAGE", "SIZE_CHART_IMAGE"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function bad(msg: string): never {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  throw e;
}
function brief(r: TtsResult) {
  return { ok: r.code === 0, http_status: r.http_status, code: r.code, message: r.message, request_id: r.request_id, data: r.data };
}

async function loadShop(shopId: unknown): Promise<Shop> {
  const id = String(shopId ?? "").trim();
  if (!id) bad("shop_id 必填");
  const { data, error } = await admin().from("tts_shops")
    .select("shop_id,shop_cipher,shop_name,region,access_token,access_expires_at").eq("shop_id", id).maybeSingle();
  if (error) throw error;
  if (!data) bad(`tts_shops 里没有 shop_id=${id}`);
  const s = data as Shop;
  if (s.access_expires_at && Date.parse(s.access_expires_at) < Date.now()) {
    bad(`店铺 ${s.shop_name ?? id} 的 access_token 已过期（${s.access_expires_at}），先用 tts-p0-probe {"action":"refresh","shop_id":"${id}"} 刷新`);
  }
  return s;
}

async function shops() {
  const { data, error } = await admin().from("tts_shops")
    .select("shop_id,shop_name,region,seller_type,scopes,access_expires_at,status").order("region");
  if (error) throw error;
  return { shops: data };
}

async function prepare(shop: Shop, b: Record<string, unknown>) {
  const cat = String(b.category_id ?? "").trim();
  if (!/^\d+$/.test(cat)) bad("category_id 必填（叶子类目 ID，如项链 605280）");
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const ver = V2_REGIONS.has((shop.region ?? "").toUpperCase()) ? "v2" : "v1";
  const [wh, rules, attrs] = [
    await ttsCall({ ...T, method: "GET", path: "/logistics/202309/warehouses" }),
    await ttsCall({ ...T, method: "GET", path: `/product/202309/categories/${cat}/rules`, query: { category_version: ver } }),
    await ttsCall({ ...T, method: "GET", path: `/product/202309/categories/${cat}/attributes`, query: { category_version: ver } }),
  ];
  return { shop: { shop_id: shop.shop_id, name: shop.shop_name, region: shop.region }, category_version: ver,
    warehouses: brief(wh), rules: brief(rules), attributes: brief(attrs) };
}

// ── 只读：给 Excel 方案自动取数（同步模板 / 全部信息模板要的商品 ID、SKU ID、详情），不再让用户手动下载导出 ──
async function findProducts(shop: Shop, b: Record<string, unknown>) {
  const skus = (Array.isArray(b.seller_skus) ? b.seller_skus : []).map((s) => String(s).trim()).filter(Boolean);
  if (!skus.length || skus.length > 100) bad("seller_skus 必填，1–100 个商家 SKU");
  const body: Record<string, unknown> = { seller_skus: skus };
  if (b.status) body.status = String(b.status); // 不传 = 全部状态（含审核中、草稿以外）
  const out: unknown[] = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const r = await ttsCall<{ products?: unknown[]; next_page_token?: string }>({
      method: "POST", path: "/product/202502/products/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { page_size: 100, page_token: token }, body,
    });
    if (r.code !== 0) return { ...brief(r), products: out };
    out.push(...(r.data?.products ?? []));
    token = r.data?.next_page_token ?? "";
    if (!token) break;
  }
  return { ok: true, products: out };
}

async function getProduct(shop: Shop, b: Record<string, unknown>) {
  const ids = (Array.isArray(b.product_ids) ? b.product_ids : [b.product_id]).map((s) => String(s ?? "").trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length || ids.length > 20) bad("product_id 或 product_ids（1–20 个）必填");
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const r = await ttsCall({
      method: "GET", path: `/product/202309/products/${id}`, accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { locale: String(b.locale ?? "zh-CN") },
    });
    out[id] = r.code === 0 ? r.data : brief(r);
  }
  return { ok: true, products: out };
}

async function replicated(shop: Shop, b: Record<string, unknown>) {
  const id = String(b.product_id ?? "").trim();
  if (!/^\d+$/.test(id)) bad("product_id 必填（源商品，如 PH 商品 ID）");
  const r = await ttsCall({
    method: "GET", path: `/product/202507/products/${id}/replicated_products`, accessToken: shop.access_token, shopCipher: shop.shop_cipher,
  });
  return brief(r);
}

const IMAGE_HOST_SUFFIXES = [
  "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "ibyteimg.com", "byteimg.com",
  "tiktok.com", "ttwstatic.com", "feishu.cn", "larksuite.com", "supabase.co",
  // 火山引擎 TOS（上架工具链图片默认地址 https://{bucket}.tos-{region}.volces.com；自定义 CDN 域名用 TTS_IMAGE_HOSTS 追加）
  "volces.com",
];

async function uploadImage(shop: Shop, b: Record<string, unknown>) {
  const url = String(b.url ?? "").trim();
  if (!/^https:\/\//.test(url)) bad("url 必须是 https 公网图片地址");
  // 安全（2026-11-23）：防止被当成服务端代理去访问内网/本机地址（SSRF）。只允许域名形式的公网地址，不跟随跳转。
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { bad("url 格式不对"); }
  // 只允许受信任的图片域名（TikTok/字节 CDN、飞书、本项目存储）；可用 TTS_IMAGE_HOSTS 追加（逗号分隔）
  const extra = (Deno.env.get("TTS_IMAGE_HOSTS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = [...IMAGE_HOST_SUFFIXES, ...extra];
  if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) {
    bad(`url 域名不在允许列表（${allowed.join(" / ")}）：${host}`);
  }
  const useCase = String(b.use_case ?? "MAIN_IMAGE");
  if (!USE_CASES.has(useCase)) bad(`use_case 只能是 ${[...USE_CASES].join(" / ")}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
  if (!res.ok) bad(`取图失败 HTTP ${res.status}：${url}`);
  if (!/^image\//i.test(res.headers.get("content-type") ?? "")) bad(`不是图片（content-type=${res.headers.get("content-type") ?? "空"}）：${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) bad(`图片大小 ${buf.length} 字节，不在 (0, 10MB]`);
  const type = res.headers.get("content-type") || "image/jpeg";
  const form = new FormData();
  form.append("data", new Blob([buf], { type }), url.split("/").pop() || "image.jpg");
  form.append("use_case", useCase);
  const r = await ttsCall<{ uri: string; url: string; width: number; height: number; use_case: string }>({
    method: "POST", path: "/product/202309/images/upload", accessToken: shop.access_token, form, write: true, timeoutMs: 60_000,
  });
  return { source: url, ...brief(r) };
}

async function createDraft(shop: Shop, b: Record<string, unknown>) {
  if (b.confirm !== "DRAFT") bad('建草稿需带 confirm:"DRAFT"');
  const p = b.product as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") bad("product 必填（Create Product 请求体）");
  const body: Record<string, unknown> = { ...p, save_mode: "AS_DRAFT" };
  if (V2_REGIONS.has((shop.region ?? "").toUpperCase())) body.category_version = "v2";
  for (const k of ["title", "category_id", "main_images", "skus"]) if (!body[k]) bad(`product.${k} 必填`);
  const r = await ttsCall({
    method: "POST", path: "/product/202309/products", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
    body, write: true, timeoutMs: 60_000,
  });
  return { shop: { shop_id: shop.shop_id, name: shop.shop_name, region: shop.region }, ...brief(r) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await requireAdmin(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(b.action ?? "");
    if (action === "shops") return json(await shops());
    const shop = await loadShop(b.shop_id);
    if (action === "prepare") return json(await prepare(shop, b));
    if (action === "find_products") return json(await findProducts(shop, b));
    if (action === "product") return json(await getProduct(shop, b));
    if (action === "replicated") return json(await replicated(shop, b));
    if (action === "upload_image") return json(await uploadImage(shop, b));
    if (action === "create_draft") return json(await createDraft(shop, b));
    bad("action 只能是 shops / prepare / find_products / product / replicated / upload_image / create_draft");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
