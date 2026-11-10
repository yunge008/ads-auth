// ⚠ 2026-11-10 起 Supabase 出口访问 ECO 全部超时（疑似被 ECO 拦截 IP）：ECO 登录 / 二次验证 / 同步余额已迁到
//   Lovable 服务端 src/lib/eco.server.ts（路由 /api/public/hooks/eco），结果写 eco_balances 表。
//   本文件只剩 ecoPing 被 balance-alert 的 debug_eco_ping 使用（测 Supabase 出口是否已解封），其余函数保留备查。
// ECO 代理商后台（business.ecoglobal.vip）只读客户端：登录 + 广告户列表。
//
// 为什么需要：ECO 代理的 TikTok 户归代理商 BC（Saboten Limited 7 / ECO DIGITAL NO.11）所有，
// 我们的 BC 即使开了财务角色，TikTok /advertiser/balance/get/ 也返回 0 个户（2026-11-09 实测），
// 现金余额又恒为 0（信用额度户），所以可用额度只能从 ECO 后台取。
//
// 接口（2026-11-09 从 ECO 前端代码 + 浏览器抓包确认）：
//   POST /api/auth/login  body {userName, passWord}（明文）→ {code:200, data:{token, expiresIn:86400, deviceId, twoFactorAuth:null}}
//   GET  /api/adaccount/list?currentPage&pageSize&startDate&endDate&specialProject=0&export=false
//        Authorization: Bearer <token> → {code:200, data:{list, total}}
//   列表项：adAccountId（= TikTok advertiser_id）/ adAccountName / totalBalance / frozenBalance / consumption / currencyCode
//   页面「可用余额」= totalBalance − frozenBalance（ECO 前端就是这么算的）。
//
// 凭据：Supabase secrets ECO_USERNAME / ECO_PASSWORD。token 不落库，每次调用现登录（一天几次，量很小）。
//
// 二次验证（2026-11-09 从 ECO 登录页代码确认）：
//   1. login 返回 code=402，data.twoFactorAuth = {availableMethods, defaultMethod, userPhone, userEmail}；method 1=短信 2=邮箱
//   2. POST /api/common/send-verify-code {account, accountType:"phone"|"email", phoneAreaCode:"+86"|"", scene:5, userName, passWord}
//   3. 再 login，body 加 twoFactorAuth:{method, code, rememberDevice:true} → 200，data.deviceId
//   4. 之后 login 带请求头 X-Device-Id=<deviceId> 即视为已信任设备，不再要求验证。
//   deviceId 存 balance_alert_settings.eco_device_id（service role only）。
import { admin } from "./auth.ts";

const ECO_BASE = "https://business.ecoglobal.vip";
const DOMAIN = "business.ecoglobal.vip";

export type EcoAccount = {
  advertiser_id: string;
  name: string | null;
  total: number | null;
  frozen: number | null;
  available: number | null;
  consumption: number | null;
  currency: string | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 重试策略（2026-11-10 改）：只有只读 GET（账户列表、连通性探测）重试；登录、发验证码一律不重试——
// 重试发验证码会连发多条短信，频繁重试登录正是触发 ECO 风控的原因之一。
async function ecoFetch(path: string, init: RequestInit = {}, attempts = 1): Promise<Record<string, unknown>> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await ecoFetchOnce(path, init);
    } catch (e) {
      last = e;
      const msg = String((e as Error).message ?? e);
      if (!/超时|fetch failed|ECONNRESET|connection|HTTP 5\d\d/i.test(msg)) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  const suffix = attempts > 1 ? `（已重试 ${attempts} 次）` : "";
  throw new Error(`${(last as Error).message}${suffix}：ECO 后台从服务器访问无响应，可能是服务器 IP 被 ECO 风控限流，稍后再试`);
}

async function ecoFetchOnce(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${ECO_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
        Origin: ECO_BASE,
        "X-Page-Domain": DOMAIN,
        Referer: `${ECO_BASE}/ad-account/manage`,
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!r.ok && j.code === undefined) throw new Error(`ECO ${path} HTTP ${r.status}: ${String(j.message ?? text).slice(0, 200)}`);
    return j;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`ECO ${path} 超时`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function ecoConfigured(): boolean {
  return !!(Deno.env.get("ECO_USERNAME") && Deno.env.get("ECO_PASSWORD"));
}

function creds() {
  const userName = Deno.env.get("ECO_USERNAME");
  const passWord = Deno.env.get("ECO_PASSWORD");
  if (!userName || !passWord) throw new Error("未配置 ECO_USERNAME / ECO_PASSWORD");
  return { userName, passWord };
}

export async function getDeviceId(): Promise<{ id: string | null; at: string | null }> {
  const { data } = await admin().from("balance_alert_settings").select("eco_device_id,eco_device_at").eq("id", 1).maybeSingle();
  return { id: (data?.eco_device_id as string) ?? null, at: (data?.eco_device_at as string) ?? null };
}

async function saveDeviceId(id: string) {
  await admin().from("balance_alert_settings")
    .update({ eco_device_id: id, eco_device_at: new Date().toISOString() }).eq("id", 1);
}

// 令牌缓存：ECO token 有效 24h，缓存到 balance_alert_settings，提前 10 分钟视为过期
async function getCachedToken(): Promise<string | null> {
  const { data } = await admin().from("balance_alert_settings").select("eco_token,eco_token_exp").eq("id", 1).maybeSingle();
  const tok = (data?.eco_token as string) ?? null;
  const exp = data?.eco_token_exp ? Date.parse(String(data.eco_token_exp)) : 0;
  return tok && exp - Date.now() > 10 * 60_000 ? tok : null;
}

async function saveToken(token: string | null, expiresInSec = 86400) {
  await admin().from("balance_alert_settings").update({
    eco_token: token,
    eco_token_exp: token ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null,
  }).eq("id", 1);
}

export const ECO_2FA_REQUIRED = "ECO_2FA_REQUIRED";

type LoginResult =
  | { ok: true; token: string }
  | { ok: false; needs2fa: true; methods: number[]; defaultMethod: number; phone: string; email: string }
  | { ok: false; needs2fa: false; message: string };

async function rawLogin(twoFactorAuth?: { method: number; code: string; rememberDevice: boolean }): Promise<LoginResult> {
  const { userName, passWord } = creds();
  const dev = await getDeviceId();
  const j = await ecoFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(dev.id ? { "X-Device-Id": dev.id } : {}) },
    body: JSON.stringify({ userName, passWord, ...(twoFactorAuth ? { twoFactorAuth } : {}) }),
  });
  const data = (j.data ?? {}) as Record<string, unknown>;
  if (j.code === 200 && data.token) {
    if (data.deviceId && data.deviceId !== dev.id) await saveDeviceId(String(data.deviceId));
    await saveToken(String(data.token), Number(data.expiresIn ?? 86400) || 86400);
    return { ok: true, token: String(data.token) };
  }
  if (j.code === 402) {
    const t = (data.twoFactorAuth ?? {}) as Record<string, unknown>;
    return {
      ok: false, needs2fa: true,
      methods: (Array.isArray(t.availableMethods) ? t.availableMethods : [1, 2]).map(Number),
      defaultMethod: Number(t.defaultMethod ?? 1),
      phone: String(t.userPhone ?? ""),
      email: String(t.userEmail ?? ""),
    };
  }
  return { ok: false, needs2fa: false, message: `ECO 登录失败 code=${j.code}: ${String(j.message ?? "")}` };
}

/** 自动登录（cron/刷新用）。需要二次验证时抛出 ECO_2FA_REQUIRED 开头的错误，由页面引导人工验证。 */
export async function ecoLogin(): Promise<string> {
  const r = await rawLogin();
  if (r.ok) return r.token;
  if (r.needs2fa) throw new Error(`${ECO_2FA_REQUIRED}：ECO 要求二次验证，请到「设置 → 账户余额预警」点「ECO 验证」完成一次`);
  throw new Error(r.message);
}

const maskPhone = (p: string) => (p.length <= 7 ? p : `${p.slice(0, 3)}****${p.slice(-4)}`);
const maskEmail = (e: string) => {
  const [a, d] = e.split("@");
  return !d || a.length <= 2 ? e : `${a.slice(0, 2)}****@${d}`;
};

/** 人工验证第 1 步：检查是否需要验证；需要则按 method 发验证码。返回脱敏后的接收方。 */
export async function eco2faSend(method?: number) {
  const r = await rawLogin();
  if (r.ok) return { needs2fa: false as const };
  if (!r.needs2fa) throw new Error(r.message);
  const m = method && r.methods.includes(method) ? method : r.defaultMethod;
  const { userName, passWord } = creds();
  const isSms = m === 1;
  const account = isSms ? r.phone : r.email;
  if (!account) throw new Error(`ECO 未返回${isSms ? "手机号" : "邮箱"}，换另一种方式试试`);
  const j = await ecoFetch("/api/common/send-verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account, accountType: isSms ? "phone" : "email", phoneAreaCode: isSms ? "+86" : "",
      scene: 5, userName, passWord,
    }),
  });
  if (j.code !== 200) throw new Error(`发送验证码失败 code=${j.code}: ${String(j.message ?? "")}`);
  return {
    needs2fa: true as const,
    method: m,
    methods: r.methods,
    recipient: isSms ? maskPhone(r.phone) : maskEmail(r.email),
  };
}

/** 人工验证第 2 步：提交验证码，成功后保存 deviceId（勾选记住设备），之后自动登录免验证。 */
export async function eco2faVerify(method: number, code: string) {
  const r = await rawLogin({ method, code: code.trim(), rememberDevice: true });
  if (r.ok) {
    const dev = await getDeviceId();
    return { ok: true, device_saved: !!dev.id };
  }
  if (r.needs2fa) throw new Error("验证码不正确或已过期，请重新获取");
  throw new Error(r.message);
}

/** 拉 ECO 全部广告户（分页）；startDate/endDate 只影响 consumption 列，余额与日期无关 */
export async function ecoListAccounts(token: string, startDate: string, endDate: string): Promise<EcoAccount[]> {
  const out: EcoAccount[] = [];
  const pageSize = 50;
  for (let page = 1; page <= 40; page++) {
    const q = new URLSearchParams({
      startDate, endDate, specialProject: "0", pageSize: String(pageSize), currentPage: String(page), export: "false",
    });
    const j = await ecoFetch(`/api/adaccount/list?${q}`, {
      headers: { Authorization: `Bearer ${token}`, Needtoken: "true", Cookie: `token=${token}` },
    }, 3);
    if (j.code === 401) throw new Error("ECO_TOKEN_INVALID");
    if (j.code !== 200) throw new Error(`ECO 账户列表失败 code=${j.code}: ${String(j.message ?? "")}`);
    const data = (j.data ?? {}) as Record<string, unknown>;
    const list = (data.list ?? []) as Array<Record<string, unknown>>;
    for (const it of list) {
      const id = String(it.adAccountId ?? "").trim();
      if (!id) continue;
      const total = num(it.totalBalance);
      const frozen = num(it.frozenBalance) ?? 0;
      out.push({
        advertiser_id: id,
        name: it.adAccountName ? String(it.adAccountName) : null,
        total,
        frozen,
        available: total == null ? null : Math.round((total - frozen) * 100) / 100,
        consumption: num(it.consumption),
        currency: it.currencyCode ? String(it.currencyCode) : null,
      });
    }
    const total = Number(data.total ?? 0);
    if (!list.length || page * pageSize >= total) break;
  }
  return out;
}

/** 拉列表：先用缓存令牌，失效（401）才重新登录一次；失败返回 error 不抛，调用方据此在每户来源里写明原因 */
export async function fetchEcoBalances(startDate: string, endDate: string): Promise<{ map: Map<string, EcoAccount>; error: string | null }> {
  const map = new Map<string, EcoAccount>();
  if (!ecoConfigured()) return { map, error: null };
  try {
    let token = await getCachedToken();
    let list: EcoAccount[] | null = null;
    if (token) {
      try {
        list = await ecoListAccounts(token, startDate, endDate);
      } catch (e) {
        if ((e as Error).message !== "ECO_TOKEN_INVALID") throw e;
        await saveToken(null);
      }
    }
    if (!list) {
      token = await ecoLogin();
      list = await ecoListAccounts(token, startDate, endDate);
    }
    for (const a of list) map.set(a.advertiser_id, a);
    return { map, error: null };
  } catch (e) {
    const msg = (e as Error).message === "ECO_TOKEN_INVALID" ? "ECO 新登录的令牌也被拒绝（401）" : (e as Error).message;
    return { map, error: msg };
  }
}

/** 连通性诊断：只发不带凭据的请求（不登录、不触发风控），看服务器能否到达 ECO */
export async function ecoPing() {
  const probe = async (label: string, path: string, init: RequestInit = {}) => {
    const t0 = Date.now();
    try {
      const j = await ecoFetchOnce(path, init);
      return { label, ok: true, ms: Date.now() - t0, code: j.code ?? null, message: j.message ?? null };
    } catch (e) {
      const msg = (e as Error).message;
      // 收到 HTTP 状态码（如 405）也说明网络是通的；只有超时/连接失败才算不通
      return { label, ok: /HTTP \d{3}/.test(msg), ms: Date.now() - t0, error: msg };
    }
  };
  const cached = await getCachedToken();
  return {
    token_cached: !!cached,
    probes: [
      await probe("账户列表(无令牌，预期 401)", "/api/adaccount/list?currentPage=1&pageSize=1"),
      await probe("登录接口(GET，预期 405)", "/api/auth/login"),
    ],
  };
}
