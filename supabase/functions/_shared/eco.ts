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

async function ecoFetch(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${ECO_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Page-Domain": DOMAIN,
        Referer: `${ECO_BASE}/ad-account/manage`,
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error(`ECO ${path} HTTP ${r.status}: ${String(j.message ?? text).slice(0, 200)}`);
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

export async function ecoLogin(): Promise<string> {
  const userName = Deno.env.get("ECO_USERNAME");
  const passWord = Deno.env.get("ECO_PASSWORD");
  if (!userName || !passWord) throw new Error("未配置 ECO_USERNAME / ECO_PASSWORD");
  const j = await ecoFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userName, passWord }),
  });
  const data = (j.data ?? {}) as Record<string, unknown>;
  if (j.code !== 200 || !data.token) {
    // twoFactorAuth 非空 = 需要验证码，自动登录走不通
    const tfa = data.twoFactorAuth ? "（ECO 要求二次验证，自动登录不可用）" : "";
    throw new Error(`ECO 登录失败 code=${j.code}: ${String(j.message ?? "")}${tfa}`);
  }
  return String(data.token);
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
    });
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

/** 登录 + 拉列表；失败返回 error 不抛，调用方据此在每户来源里写明原因 */
export async function fetchEcoBalances(startDate: string, endDate: string): Promise<{ map: Map<string, EcoAccount>; error: string | null }> {
  const map = new Map<string, EcoAccount>();
  if (!ecoConfigured()) return { map, error: null };
  try {
    const token = await ecoLogin();
    for (const a of await ecoListAccounts(token, startDate, endDate)) map.set(a.advertiser_id, a);
    return { map, error: null };
  } catch (e) {
    return { map, error: (e as Error).message };
  }
}
