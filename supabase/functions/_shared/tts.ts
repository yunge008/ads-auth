// TikTok Shop Open API（Partner API）客户端 —— 联盟达人外联专用。
//
// 与 `_shared/tiktok.ts`（TikTok Business API，广告授权/GMV Max）是两条不同线路：
// Host、鉴权方式、签名、限速全都不同，按交接文档要求独立实现，不复用、不修改 tiktok.ts。
//
// 官方依据（2026-11-05 从 Partner Center 文档拉取）：
// - 签名 Sign your API request：
//   sign = hex(HMAC-SHA256(key=app_secret,
//            app_secret + path + 按 key 字母序拼接的 {key}{value}（排除 sign / access_token）
//            + 请求体原文（非 multipart 时） + app_secret))
// - 202309 及以后版本 access token 放 header `x-tts-access-token`，不参与签名
// - token：GET https://auth.tiktok-shops.com/api/v2/token/get?grant_type=authorized_code
//          GET https://auth.tiktok-shops.com/api/v2/token/refresh?grant_type=refresh_token
//   access_token 默认 7 天有效；auth_code 30 分钟内一次性有效
// - 限流信号：HTTP 429 或业务码 36009002 → 指数退避 + 抖动

import { admin } from "./auth.ts";

export const TTS_API_HOST = "https://open-api.tiktokglobalshop.com";
export const TTS_AUTH_HOST = "https://auth.tiktok-shops.com";

/** 平台限流业务码（Rate limits 文档 §4）。 */
export const TTS_RATE_LIMIT_CODE = 36009002;

export function ttsAppCreds(): { appKey: string; appSecret: string } {
  const appKey = Deno.env.get("TTS_APP_KEY") ?? "";
  const appSecret = Deno.env.get("TTS_APP_SECRET") ?? "";
  if (!appKey || !appSecret) {
    throw new Error("缺少 Supabase secrets：TTS_APP_KEY / TTS_APP_SECRET（在 Supabase → Edge Functions → Secrets 设置）");
  }
  return { appKey, appSecret };
}

// ── 多应用（2026-11-23）──────────────────────────────────────────────────────
// 每个店铺主体一个「商家自用」应用，凭据存表 tts_apps；tts_shops.app_code 记录店铺由哪个应用授权。
// token 只能配签发它的应用签名：ttsCall 不传 app 时按 access_token 反查店铺所属应用（isolate 内缓存），
// 所以现有调用方（tts-export / tts-listing / sea-inventory / outreach）无需改动。
// code='default' 且表里 app_key 为空时回落到 secrets TTS_APP_KEY / TTS_APP_SECRET（原应用）。
export type TtsApp = { code: string; appKey: string; appSecret: string; serviceId: string };
export const TTS_DEFAULT_APP = "default";

const appCache = new Map<string, TtsApp>();
const tokenAppCache = new Map<string, string>();

export async function ttsApp(code: string): Promise<TtsApp> {
  const c = (code || TTS_DEFAULT_APP).trim();
  const hit = appCache.get(c);
  if (hit) return hit;
  const { data, error } = await admin().from("tts_apps").select("code,app_key,app_secret,service_id").eq("code", c).maybeSingle();
  // 表还没建（migration 未跑）时，default 仍可用 secrets
  if (error && c !== TTS_DEFAULT_APP) throw new Error(`读取 tts_apps 失败：${error.message}`);
  let app: TtsApp | null = null;
  if (data?.app_key && data?.app_secret) {
    app = { code: c, appKey: data.app_key, appSecret: data.app_secret, serviceId: data.service_id ?? "" };
  } else if (c === TTS_DEFAULT_APP) {
    const { appKey, appSecret } = ttsAppCreds();
    app = { code: c, appKey, appSecret, serviceId: data?.service_id || (Deno.env.get("TTS_SERVICE_ID") ?? "").trim() };
  }
  if (!app) throw new Error(`应用 ${c} 未配置 App Key / App Secret（设置 → TikTok Shop 授权 → 应用）`);
  appCache.set(c, app);
  return app;
}

export function ttsAppCacheClear() {
  appCache.clear();
}

/** 按 access_token 找店铺所属应用；找不到（如刚换到、尚未入库的 token）按 default。 */
async function appForToken(accessToken: string): Promise<TtsApp> {
  let code = tokenAppCache.get(accessToken);
  if (!code) {
    const { data, error } = await admin().from("tts_shops").select("app_code").eq("access_token", accessToken).limit(1).maybeSingle();
    code = (!error && data?.app_code) ? String(data.app_code) : TTS_DEFAULT_APP;
    tokenAppCache.set(accessToken, code);
  }
  return ttsApp(code);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 计算签名。body 必须是实际发送的字节原文（不要重新序列化）。 */
export async function ttsSign(
  path: string,
  query: Record<string, string>,
  body: string,
  appSecret: string,
): Promise<string> {
  const keys = Object.keys(query).filter((k) => k !== "sign" && k !== "access_token").sort();
  let s = path;
  for (const k of keys) s += k + query[k];
  if (body) s += body;
  s = appSecret + s + appSecret;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(s)));
}

export type TtsResult<T = unknown> = {
  method: string;
  path: string;
  http_status: number;
  code: number | null;
  message: string;
  request_id: string;
  data: T | null;
  ms: number;
  attempts: number;
};

// 同一 isolate 内串行限速：两次请求间隔 ≥ 350ms（≈3 QPS，沿用现有经验值）。
let lastCallAt = 0;
const MIN_GAP_MS = 350;
async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export type TtsCallOpts = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  accessToken: string;
  shopCipher?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown; // 省略 = 不发请求体
  /** multipart/form-data 请求体（如上传商品图片）。按官方签名规则，multipart 请求体不参与签名。与 body 互斥。 */
  form?: FormData;
  /** 写操作：只在「明确被限流拒绝」时重试，绝不在超时/5xx 时重试，避免重复建计划/重复发消息。 */
  write?: boolean;
  timeoutMs?: number;
  /** 指定应用；省略时按 accessToken 反查店铺所属应用。 */
  app?: TtsApp;
};

// ── 读写闸门（2026-11-16 负责人规定）────────────────────────────────────────
// 所有 TTS 接口默认只读：GET，以及路径以 /search、/filter、/query、/check 结尾的查询类 POST。
// 写接口只放行下表（2026-11-17 起含达人私信）；新增任何写接口必须先经负责人逐条明确确认，再加到这里。
const TTS_WRITE_ALLOW: Array<{ method: string; path: RegExp; why: string; body?: (b: unknown) => string | null }> = [
  // 2026-11-17 负责人确认放开：商品上架只写草稿（AS_DRAFT），人工在 Seller Center 审核后发布。
  { method: "POST", path: /^\/product\/\d+\/images\/upload$/, why: "上传商品图片（只生成 TikTok 图片 URI，不影响在售商品）" },
  {
    method: "POST", path: /^\/product\/\d+\/products$/, why: "新建商品（仅草稿）",
    body: (b) => (b as { save_mode?: string } | null)?.save_mode === "AS_DRAFT" ? null : "新建商品只允许 save_mode=AS_DRAFT（写草稿，人工审核后发布）",
  },
  { method: "POST", path: /^\/affiliate_seller\/\d+\/target_collaborations$/, why: "新建定向计划" },
  { method: "PUT", path: /^\/affiliate_seller\/\d+\/target_collaborations\/\d+$/, why: "修改定向计划" },
  // 2026-11-17 负责人确认放开：达人私信（建会话 / 发消息 / 标已读）。发送前必须经 BD 确认由业务函数保证。
  { method: "POST", path: /^\/affiliate_seller\/\d+\/conversations$/, why: "建立/获取达人会话" },
  { method: "POST", path: /^\/affiliate_seller\/\d+\/conversations\/[^/]+\/messages$/, why: "发送达人私信" },
  { method: "POST", path: /^\/affiliate_seller\/\d+\/conversatons\/read$/, why: "达人会话标为已读（官方路径拼写为 conversatons）" },
  // 2026-11-17 负责人要求「SEA库存监控」确认后经 API 改库存。只允许设数量（INCREMENTAL），不允许 FULL 替换仓库列表、不允许解除仓库关联。
  {
    method: "POST", path: /^\/product\/\d+\/products\/\d+\/inventory\/update$/, why: "改 listing 库存（SEA库存监控，用户确认后执行）",
    body: (b) => {
      const x = (b ?? {}) as { sku_warehouse_stock_update_mode?: string; skus?: Array<{ unlink_warehouse_ids?: unknown[]; inventory?: unknown[] }> };
      if (x.sku_warehouse_stock_update_mode !== "INCREMENTAL") return "改库存只允许 sku_warehouse_stock_update_mode=INCREMENTAL";
      if (!Array.isArray(x.skus) || !x.skus.length) return "skus 不能为空";
      if (x.skus.some((s) => (s.unlink_warehouse_ids?.length ?? 0) > 0)) return "不允许解除仓库关联（unlink_warehouse_ids）";
      if (x.skus.some((s) => !Array.isArray(s.inventory) || !s.inventory.length)) return "每个 SKU 必须带 inventory";
      return null;
    },
  },
  { method: "POST", path: /^\/product\/\d+\/global_products\/\d+\/inventory\/update$/, why: "改全球商品库存（跨境店，SEA库存监控，用户确认后执行）" },
];
const TTS_READ_POST = /\/(search|filter|query|check)$/;

/** 返回 null 表示放行；否则返回拦截原因。 */
export function ttsAccessCheck(method: string, path: string, body?: unknown): string | null {
  const m = method.toUpperCase();
  if (m === "GET") return null;
  if (m === "POST" && TTS_READ_POST.test(path)) return null;
  const w = TTS_WRITE_ALLOW.find((w) => w.method === m && w.path.test(path));
  if (w) {
    const why = w.body?.(body ?? null);
    return why ? `只读闸门拦截：${m} ${path}：${why}` : null;
  }
  return `只读闸门拦截：${m} ${path} 不在允许清单内（当前只允许读取 + 定向计划新建/修改 + 达人私信 + 商品草稿 + 改库存；其他写接口需负责人确认后加入 _shared/tts.ts 的 TTS_WRITE_ALLOW）`;
}

export async function ttsCall<T = unknown>(opts: TtsCallOpts): Promise<TtsResult<T>> {
  const blocked = ttsAccessCheck(opts.method, opts.path, opts.body);
  if (blocked) {
    return {
      method: opts.method, path: opts.path, http_status: 0, code: null, message: blocked,
      request_id: "", data: null, ms: 0, attempts: 0,
    };
  }
  const { appKey, appSecret } = opts.app ?? await appForToken(opts.accessToken);
  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const maxAttempts = 5;
  const started = Date.now();
  let last: TtsResult<T> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") q[k] = String(v);
    }
    q.app_key = appKey;
    q.timestamp = String(Math.floor(Date.now() / 1000));
    if (opts.shopCipher) q.shop_cipher = opts.shopCipher;
    q.sign = await ttsSign(opts.path, q, bodyStr, appSecret);

    const url = `${TTS_API_HOST}${opts.path}?${new URLSearchParams(q).toString()}`;
    await throttle();
    let httpStatus = 0;
    let json: { code?: number; message?: string; request_id?: string; data?: T } = {};
    let retryable = false;
    try {
      const res = await fetch(url, {
        method: opts.method,
        // multipart 时不手动设 content-type，由 fetch 生成带 boundary 的头
        headers: opts.form
          ? { "x-tts-access-token": opts.accessToken }
          : { "content-type": "application/json", "x-tts-access-token": opts.accessToken },
        body: opts.form ?? (bodyStr || undefined),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      httpStatus = res.status;
      const text = await res.text();
      try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 500) }; }
      const limited = httpStatus === 429 || json.code === TTS_RATE_LIMIT_CODE;
      retryable = limited || (!opts.write && (httpStatus === 503 || httpStatus >= 500));
    } catch (e) {
      json = { message: `network/timeout: ${(e as Error).message}` };
      retryable = !opts.write; // 写操作超时不重试：可能已经成功
    }
    last = {
      method: opts.method,
      path: opts.path,
      http_status: httpStatus,
      code: typeof json.code === "number" ? json.code : null,
      message: json.message ?? "",
      request_id: json.request_id ?? "",
      data: (json.data ?? null) as T | null,
      ms: Date.now() - started,
      attempts: attempt,
    };
    if (!retryable || attempt === maxAttempts) break;
    const backoff = Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
    await new Promise((r) => setTimeout(r, backoff));
  }
  return last!;
}

export type TtsToken = {
  access_token: string;
  access_token_expire_in: number;
  refresh_token: string;
  refresh_token_expire_in: number;
  open_id: string;
  seller_name: string;
  seller_base_region: string;
  user_type: number;
  granted_scopes: string[];
};

async function tokenRequest(path: string, params: Record<string, string>, app: TtsApp): Promise<TtsToken> {
  const q = new URLSearchParams({ app_key: app.appKey, app_secret: app.appSecret, ...params });
  const res = await fetch(`${TTS_AUTH_HOST}${path}?${q.toString()}`, { signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => ({})) as { code?: number; message?: string; data?: TtsToken };
  if (json.code !== 0 || !json.data?.access_token) {
    throw new Error(`TikTok Shop token 接口失败（应用 ${app.code}）：code=${json.code} ${json.message ?? ""}`.trim());
  }
  return json.data;
}

/** auth_code → token。注意 grant_type 官方要求就是 authorized_code（不是 authorization_code）。auth_code 绑定签发它的应用。 */
export function ttsExchangeCode(authCode: string, app: TtsApp): Promise<TtsToken> {
  return tokenRequest("/api/v2/token/get", { auth_code: authCode, grant_type: "authorized_code" }, app);
}

export function ttsRefreshToken(refreshToken: string, app: TtsApp): Promise<TtsToken> {
  return tokenRequest("/api/v2/token/refresh", { refresh_token: refreshToken, grant_type: "refresh_token" }, app);
}

/** Excel 里的达人账号规范化：去 @、去空白、转小写。 */
export function normalizeHandle(raw: string): string {
  return String(raw ?? "").trim().replace(/^@+/, "").replace(/\s+/g, "").toLowerCase();
}

/** 定向佣金：百分数 → 接口单位（万分比，1000 = 10%）。官方文档：target_commission_rate 最小 100（=1%）。 */
export function pctToRate(pct: number): number {
  return Math.round(pct * 100);
}
