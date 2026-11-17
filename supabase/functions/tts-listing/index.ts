// TikTok Shop 商品上架（只写草稿）。供 tools/tts-listing（Claude / Codex 本地执行）和后续网页端调用。仅管理员。
//
// action：
//   shops                                   已授权店铺列表（不含 token）：shop_id / 名称 / 站点 / 卖家类型 / 授权 scope
//   prepare   {shop_id, category_id}        只读：仓库列表 + 类目规则 + 类目属性（含销售属性），建草稿前核对用
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

async function uploadImage(shop: Shop, b: Record<string, unknown>) {
  const url = String(b.url ?? "").trim();
  if (!/^https:\/\//.test(url)) bad("url 必须是 https 公网图片地址");
  const useCase = String(b.use_case ?? "MAIN_IMAGE");
  if (!USE_CASES.has(useCase)) bad(`use_case 只能是 ${[...USE_CASES].join(" / ")}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) bad(`取图失败 HTTP ${res.status}：${url}`);
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
    if (action === "upload_image") return json(await uploadImage(shop, b));
    if (action === "create_draft") return json(await createDraft(shop, b));
    bad("action 只能是 shops / prepare / upload_image / create_draft");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
