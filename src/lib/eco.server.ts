// ECO 代理商后台（business.ecoglobal.vip）只读客户端 —— 服务端路由版（跑在 Lovable/Cloudflare）。
//
// 为什么不在 Supabase Edge Function 里调：2026-11-10 起 Supabase 出口访问 ECO 全部超时（无凭据请求也超时，
// 判断为 ECO 拦了 Supabase 出口 IP），而 Cloudflare 出口正常（/api/public/hooks/eco-ping 实测 401/405 秒回）。
// 所以 ECO 登录、二次验证、拉余额都在这里做，结果写 eco_balances 表，Edge Function balance-alert 只读表。
//
// 接口（从 ECO 前端代码 + 抓包确认，见 supabase/functions/_shared/eco.ts 头注释）：
//   POST /api/auth/login {userName, passWord} → 200 {token, expiresIn, deviceId} / 402 需二次验证
//   POST /api/common/send-verify-code {account, accountType, phoneAreaCode, scene:5, userName, passWord}
//   GET  /api/adaccount/list  Bearer token → {list, total}；可用余额 = totalBalance − frozenBalance
// 令牌缓存在 balance_alert_settings.eco_token/eco_token_exp（一天只登录一次）；信任设备 eco_device_id。
// 凭据：服务端环境变量 ECO_USERNAME / ECO_PASSWORD（Cloudflare Workers：必须在请求内读 process.env）。
import process from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ECO_BASE = "https://business.ecoglobal.vip";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

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

export function db(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function creds() {
  const userName = process.env.ECO_USERNAME;
  const passWord = process.env.ECO_PASSWORD;
  if (!userName || !passWord)
    throw new Error("服务端未配置 ECO_USERNAME / ECO_PASSWORD（Lovable 服务端环境变量）");
  return { userName, passWord };
}

async function ecoFetchOnce(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${ECO_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": UA,
        Origin: ECO_BASE,
        Referer: `${ECO_BASE}/ad-account/manage`,
        "X-Page-Domain": "business.ecoglobal.vip",
        ...((init.headers as Record<string, string>) ?? {}),
      },
      signal: ctrl.signal,
    });
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (!r.ok && j.code === undefined)
      throw new Error(`ECO ${path} HTTP ${r.status}: ${String(j.message ?? text).slice(0, 200)}`);
    return j;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`ECO ${path} 超时`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 只读 GET 才重试；登录、发验证码不重试（避免连发短信、反复登录触发风控）
async function ecoGet(path: string, headers: Record<string, string>) {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await ecoFetchOnce(path, { headers });
    } catch (e) {
      last = e;
      if (!/超时|fetch failed|ECONNRESET|connection|HTTP 5\d\d/i.test((e as Error).message))
        throw e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

// ---------- 设备 / 令牌缓存 ----------
async function getSettings() {
  const { data } = await db()
    .from("balance_alert_settings")
    .select("eco_device_id,eco_device_at,eco_token,eco_token_exp")
    .eq("id", 1)
    .maybeSingle();
  return (data ?? {}) as Record<string, string | null>;
}

async function patchSettings(patch: Record<string, unknown>) {
  await db().from("balance_alert_settings").update(patch).eq("id", 1);
}

export const ECO_2FA_REQUIRED = "ECO_2FA_REQUIRED";

type LoginResult =
  | { ok: true; token: string }
  | {
      ok: false;
      needs2fa: true;
      methods: number[];
      defaultMethod: number;
      phone: string;
      email: string;
    }
  | { ok: false; needs2fa: false; message: string };

async function rawLogin(twoFactorAuth?: {
  method: number;
  code: string;
  rememberDevice: boolean;
}): Promise<LoginResult> {
  const { userName, passWord } = creds();
  const s = await getSettings();
  const j = await ecoFetchOnce("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(s.eco_device_id ? { "X-Device-Id": s.eco_device_id } : {}),
    },
    body: JSON.stringify({ userName, passWord, ...(twoFactorAuth ? { twoFactorAuth } : {}) }),
  });
  const data = (j.data ?? {}) as Record<string, unknown>;
  if (j.code === 200 && data.token) {
    const patch: Record<string, unknown> = {
      eco_token: String(data.token),
      eco_token_exp: new Date(
        Date.now() + (Number(data.expiresIn ?? 86400) || 86400) * 1000,
      ).toISOString(),
    };
    if (data.deviceId && data.deviceId !== s.eco_device_id) {
      patch.eco_device_id = String(data.deviceId);
      patch.eco_device_at = new Date().toISOString();
    }
    await patchSettings(patch);
    return { ok: true, token: String(data.token) };
  }
  if (j.code === 402) {
    const t = (data.twoFactorAuth ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      needs2fa: true,
      methods: (Array.isArray(t.availableMethods) ? t.availableMethods : [1, 2]).map(Number),
      defaultMethod: Number(t.defaultMethod ?? 1),
      phone: String(t.userPhone ?? ""),
      email: String(t.userEmail ?? ""),
    };
  }
  return {
    ok: false,
    needs2fa: false,
    message: `ECO 登录失败 code=${j.code}: ${String(j.message ?? "")}`,
  };
}

async function ecoLogin(): Promise<string> {
  const r = await rawLogin();
  if (r.ok) return r.token;
  if (r.needs2fa)
    throw new Error(
      `${ECO_2FA_REQUIRED}：ECO 要求二次验证，请到「设置 → 账户余额预警」点「ECO 验证」完成一次`,
    );
  throw new Error(r.message);
}

async function cachedToken(): Promise<string | null> {
  const s = await getSettings();
  const exp = s.eco_token_exp ? Date.parse(s.eco_token_exp) : 0;
  return s.eco_token && exp - Date.now() > 10 * 60_000 ? s.eco_token : null;
}

// ---------- 账户列表 ----------
async function listAccounts(token: string, startDate: string, endDate: string) {
  const out: EcoAccount[] = [];
  const pageSize = 50;
  for (let page = 1; page <= 40; page++) {
    const q = new URLSearchParams({
      startDate,
      endDate,
      specialProject: "0",
      pageSize: String(pageSize),
      currentPage: String(page),
      export: "false",
    });
    const j = await ecoGet(`/api/adaccount/list?${q}`, {
      Authorization: `Bearer ${token}`,
      Needtoken: "true",
      Cookie: `token=${token}`,
    });
    if (j.code === 401) throw new Error("ECO_TOKEN_INVALID");
    if (j.code !== 200)
      throw new Error(`ECO 账户列表失败 code=${j.code}: ${String(j.message ?? "")}`);
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
    if (!list.length || page * pageSize >= Number(data.total ?? 0)) break;
  }
  return out;
}

const bjDate = (offset: number) =>
  new Date(Date.now() + 8 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

// 作废 = fetched_at 置为 1970，Edge Function balance-alert 只用 24h 内的行，作废行即视为「无余额」。
// keepSince 非空：只作废早于该时刻的行（即本次同步没覆盖到的户）；为空：全部作废。
const EPOCH = "1970-01-01T00:00:00Z";
async function invalidateEcoBalances(keepSince: string | null) {
  let q = db().from("eco_balances").update({ fetched_at: EPOCH });
  q = keepSince ? q.lt("fetched_at", keepSince) : q.gt("fetched_at", EPOCH);
  const { error } = await q;
  if (error) throw new Error(`作废旧 ECO 余额失败：${error.message}`);
}

/** 同步 ECO 余额到 eco_balances；结果（成功/失败）记到 balance_alert_settings.eco_sync_* */
export async function syncEcoBalances(): Promise<{
  ok: boolean;
  count: number;
  error?: string;
}> {
  const startDate = bjDate(-10);
  const endDate = bjDate(-1);
  try {
    let list: EcoAccount[] | null = null;
    const tok = await cachedToken();
    if (tok) {
      try {
        list = await listAccounts(tok, startDate, endDate);
      } catch (e) {
        if ((e as Error).message !== "ECO_TOKEN_INVALID") throw e;
        await patchSettings({ eco_token: null, eco_token_exp: null });
      }
    }
    if (!list) list = await listAccounts(await ecoLogin(), startDate, endDate);
    const now = new Date().toISOString();
    if (list.length) {
      const { error } = await db()
        .from("eco_balances")
        .upsert(
          list.map((a) => ({ ...a, fetched_at: now })),
          { onConflict: "advertiser_id" },
        );
      if (error) throw new Error(`写 eco_balances 失败：${error.message}`);
    }
    // 本次 ECO 列表里没有的户：作废旧余额（不允许用旧数据估算）
    await invalidateEcoBalances(now);
    await patchSettings({ eco_sync_at: now, eco_sync_error: null, eco_sync_count: list.length });
    return { ok: true, count: list.length };
  } catch (e) {
    const msg = (e as Error).message;
    // 同步失败：作废全部已存 ECO 余额，这批户当天显示「算不出」并注明原因，绝不沿用旧余额估算
    await invalidateEcoBalances(null).catch(() => {});
    await patchSettings({
      eco_sync_error: msg.slice(0, 500),
      eco_sync_error_at: new Date().toISOString(),
    });
    return { ok: false, count: 0, error: msg };
  }
}

// ---------- 人工二次验证 ----------
const maskPhone = (p: string) => (p.length <= 7 ? p : `${p.slice(0, 3)}****${p.slice(-4)}`);
const maskEmail = (e: string) => {
  const [a, d] = e.split("@");
  return !d || a.length <= 2 ? e : `${a.slice(0, 2)}****@${d}`;
};

export async function eco2faSend(method?: number) {
  const r = await rawLogin();
  if (r.ok) return { needs2fa: false as const };
  if (!r.needs2fa) throw new Error(r.message);
  const m = method && r.methods.includes(method) ? method : r.defaultMethod;
  const { userName, passWord } = creds();
  const isSms = m === 1;
  const account = isSms ? r.phone : r.email;
  if (!account) throw new Error(`ECO 未返回${isSms ? "手机号" : "邮箱"}，换另一种方式试试`);
  const j = await ecoFetchOnce("/api/common/send-verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account,
      accountType: isSms ? "phone" : "email",
      phoneAreaCode: isSms ? "+86" : "",
      scene: 5,
      userName,
      passWord,
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

export async function eco2faVerify(method: number, code: string) {
  const r = await rawLogin({ method, code: code.trim(), rememberDevice: true });
  if (r.ok) return { ok: true };
  if (r.needs2fa) throw new Error("验证码不正确或已过期，请重新获取");
  throw new Error(r.message);
}

export async function ecoStatus() {
  const { data } = await db()
    .from("balance_alert_settings")
    .select(
      "eco_device_id,eco_device_at,eco_sync_at,eco_sync_error,eco_sync_error_at,eco_sync_count",
    )
    .eq("id", 1)
    .maybeSingle();
  const s = (data ?? {}) as Record<string, unknown>;
  return {
    configured: !!(process.env.ECO_USERNAME && process.env.ECO_PASSWORD),
    device_saved: !!s.eco_device_id,
    device_at: (s.eco_device_at as string) ?? null,
    sync_at: (s.eco_sync_at as string) ?? null,
    sync_count: (s.eco_sync_count as number) ?? null,
    sync_error: (s.eco_sync_error as string) ?? null,
    sync_error_at: (s.eco_sync_error_at as string) ?? null,
  };
}
