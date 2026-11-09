// 账户余额预警（设置 → 账户余额预警）。
//
// actions:
//   list                           → { settings, accounts }（读库里快照，不调 TikTok）
//   save_settings {threshold_days?, abnormal_ratio?, feishu_chat_id?, feishu_chat_name?}
//   toggle {advertiser_id, enabled}
//   refresh {advertiser_ids?}      → 现拉余额 + 近 10 天日耗，写快照；超时间预算返回 remaining 让调用方续跑
//   build_message {force?}         → 组装预警消息 {send,title,lines,alert_ids}，**不发送**；
//                                    发送由服务端路由 /api/public/hooks/balance-alert-cron 用 FEISHU_BOT_WEBHOOK
//                                    （与每日自动授权通知同一个群）完成，因为该 webhook 只配在服务端环境变量里
//   mark_alerted {advertiser_ids}  → 发送成功后记 last_alerted_at
//   debug_balance {advertiser_id}  → 两个余额接口对该户的原始返回（API测试页诊断用）
//   debug_eco                      → 登录 ECO 后台并返回其广告户余额列表（不含 token）
//   eco_status / eco_2fa_send {method} / eco_2fa_verify {method, code} → ECO 二次验证（仅管理员）
// 余额优先级：ECO 后台可用余额（_shared/eco.ts）> TikTok 接口（pickAvailableBalance）
//
// 鉴权：口令 + settings tab；cron（x-cron-key）只放行 refresh / build_message / mark_alerted。
// TikTok 调用一律走 _shared/tiktok.ts 的 ttGet（限速 + 退避）。
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, requireAdmin, type ConnRow } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { ttGet } from "../_shared/tiktok.ts";
import { fetchReport } from "../_shared/gmv-max-report.ts";
import { eco2faSend, eco2faVerify, ecoConfigured, ecoListAccounts, ecoLogin, fetchEcoBalances, getDeviceId } from "../_shared/eco.ts";
import {
  computeSpendStats,
  DEFAULT_ABNORMAL_RATIO,
  daysLeft,
  dayLevel,
  mergeDailySpend,
  NEAR_DAYS,
  overallLevel,
  pickAvailableBalance,
  shouldAlert,
  spendWindow,
} from "../_shared/balance-alert.ts";

const TIME_BUDGET_MS = 100_000;

type Settings = {
  threshold_days: number;
  abnormal_ratio: number;
  feishu_chat_id: string | null;
  feishu_chat_name: string | null;
  last_run_at: string | null;
  last_run_summary: unknown;
};

type BalanceInfo = { balance: number | null; currency: string | null; name: string | null; source: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function loadSettings(): Promise<Settings> {
  const { data, error } = await admin().from("balance_alert_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return {
    threshold_days: Number(data?.threshold_days ?? 3),
    abnormal_ratio: Number(data?.abnormal_ratio ?? DEFAULT_ABNORMAL_RATIO),
    feishu_chat_id: data?.feishu_chat_id ?? null,
    feishu_chat_name: data?.feishu_chat_name ?? null,
    last_run_at: data?.last_run_at ?? null,
    last_run_summary: data?.last_run_summary ?? null,
  };
}

async function loadConnections(): Promise<ConnRow[]> {
  const { data, error } = await admin().from("tiktok_connections").select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as ConnRow[];
}

function allAdvertiserIds(conns: ConnRow[]): string[] {
  const s = new Set<string>();
  for (const c of conns) for (const id of c.advertiser_ids ?? []) s.add(String(id));
  return [...s];
}

// ---------- 余额 ----------
// 两个来源都拉，逐户记录原始值（写进 balance_source 便于核对）：
//   A. BC 接口 /advertiser/balance/get/（只返回该 BC 有**管理员**权限的户）：valid_account_balance（可用）/ account_balance
//   B. /advertiser/info/ 的 balance
// 取值：A 列出该户 → 用 A 的 valid_account_balance（无则 account_balance）；
//       A 未列出 → B.balance > 0 才采用；B.balance = 0 视为「无权限读余额」不可信 → 余额记 null，不参与预警
//       （2026-11-09 实测：代理商 BC 管理的 ECO9 户在 ECO 后台有数千美元余额，我们这边却拿到 0.00，
//        若照单全收会对 10 个正常户误报「可用 0 天」）。
type BalanceRaw = {
  bc?: {
    label: string; valid: number | null; total: number | null; currency: string | null; name: string | null;
    budgetMode: string | null; budget: number | null; budgetCost: number | null; budgetRemaining: number | null;
    raw: Record<string, unknown>;
  };
  info?: { label: string; balance: number | null; currency: string | null; name: string | null };
};

async function fetchBalances(conns: ConnRow[], wanted: Set<string>): Promise<{ map: Map<string, BalanceInfo>; errors: string[] }> {
  const raw = new Map<string, BalanceRaw>();
  const errors: string[] = [];
  const get = (id: string) => raw.get(id) ?? (raw.set(id, {}), raw.get(id)!);
  for (const c of conns) {
    if (!c.bc_id) continue;
    try {
      for (let page = 1; page <= 50; page++) {
        const data = await ttGet(c.access_token, "/advertiser/balance/get/", {
          bc_id: c.bc_id, page: String(page), page_size: "50",
        });
        const list = (data.advertiser_account_list ?? data.list ?? []) as Array<Record<string, unknown>>;
        for (const it of list) {
          const id = String(it.advertiser_id ?? "");
          if (!id || !wanted.has(id) || get(id).bc) continue;
          get(id).bc = {
            label: c.label,
            valid: numOrNull(it.valid_account_balance),
            total: numOrNull(it.account_balance),
            currency: it.currency ? String(it.currency) : null,
            name: it.advertiser_name ? String(it.advertiser_name) : null,
            budgetMode: it.budget_mode ? String(it.budget_mode) : null,
            budget: numOrNull(it.budget),
            budgetCost: numOrNull(it.budget_cost),
            budgetRemaining: numOrNull(it.budget_remaining),
            raw: it,
          };
        }
        const info = (data.page_info ?? {}) as Record<string, unknown>;
        const totalPage = Number(info.total_page ?? 0);
        if (!list.length || !totalPage || page >= totalPage) break;
      }
    } catch (e) {
      errors.push(`[${c.label}] advertiser/balance/get: ${(e as Error).message}`);
    }
  }
  for (const c of conns) {
    const ids = (c.advertiser_ids ?? []).map(String).filter((id) => wanted.has(id) && !raw.get(id)?.info);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try {
        const data = await ttGet(c.access_token, "/advertiser/info/", {
          advertiser_ids: JSON.stringify(batch),
          fields: JSON.stringify(["advertiser_id", "name", "balance", "currency"]),
        });
        const list = (Array.isArray(data.list) ? data.list : []) as Array<Record<string, unknown>>;
        for (const it of list) {
          const id = String(it.advertiser_id ?? "");
          if (!id || get(id).info) continue;
          get(id).info = {
            label: c.label,
            balance: numOrNull(it.balance),
            currency: it.currency ? String(it.currency) : null,
            name: it.name ? String(it.name) : null,
          };
        }
      } catch (e) {
        errors.push(`[${c.label}] advertiser/info: ${(e as Error).message}`);
      }
    }
  }
  const map = new Map<string, BalanceInfo>();
  // BC 接口整体失败时，所有户都会落到「BC 未列出」，必须把失败原因带进每户的来源说明，否则会被误读成无权限。
  const bcFailed = errors.filter((e) => e.includes("advertiser/balance/get")).join("；");
  for (const [id, r] of raw) {
    const { balance, verdict } = pickAvailableBalance({
      bcListed: !!r.bc,
      valid: r.bc?.valid ?? null,
      total: r.bc?.total ?? null,
      budgetMode: r.bc?.budgetMode ?? null,
      budget: r.bc?.budget ?? null,
      budgetCost: r.bc?.budgetCost ?? null,
      budgetRemaining: r.bc?.budgetRemaining ?? null,
      infoBalance: r.info?.balance ?? null,
    });
    // 原始字段整条留痕（只留标量），字段名不确定时看这里即可，不必再加诊断部署
    const bcPart = r.bc
      ? `BC[${r.bc.label}] ${JSON.stringify(Object.fromEntries(Object.entries(r.bc.raw).filter(([, v]) => v === null || typeof v !== "object")))}`
      : `BC 余额接口未返回该户${bcFailed ? `（接口报错：${bcFailed}）` : "（该 BC 无此户管理员权限）"}`;
    const infoPart = r.info ? `info[${r.info.label}].balance=${r.info.balance ?? "空"}` : "info 未返回";
    map.set(id, {
      balance,
      currency: r.bc?.currency ?? r.info?.currency ?? null,
      name: r.bc?.name ?? r.info?.name ?? null,
      source: `${verdict}｜${bcPart}；${infoPart}`,
    });
  }
  return { map, errors };
}

// 诊断：返回某个户在每个连接下两个余额接口的原始返回，用于核对字段/权限。
async function debugBalance(conns: ConnRow[], advertiserId: string) {
  const out: Array<Record<string, unknown>> = [];
  for (const c of conns.filter((x) => (x.advertiser_ids ?? []).map(String).includes(advertiserId))) {
    const item: Record<string, unknown> = { connection: c.label, bc_id: c.bc_id, bc_name: c.bc_name };
    if (c.bc_id) {
      try {
        let found: unknown = null;
        let total = 0;
        for (let page = 1; page <= 50 && !found; page++) {
          const data = await ttGet(c.access_token, "/advertiser/balance/get/", { bc_id: c.bc_id, page: String(page), page_size: "50" });
          const list = (data.advertiser_account_list ?? data.list ?? []) as Array<Record<string, unknown>>;
          total += list.length;
          found = list.find((it) => String(it.advertiser_id) === advertiserId) ?? null;
          const pi = (data.page_info ?? {}) as Record<string, unknown>;
          if (!list.length || page >= Number(pi.total_page ?? 0)) break;
        }
        item.bc_balance = found ?? `未列出（该 BC 共返回 ${total} 个户）`;
      } catch (e) {
        item.bc_balance_error = (e as Error).message;
      }
    }
    try {
      const data = await ttGet(c.access_token, "/advertiser/info/", {
        advertiser_ids: JSON.stringify([advertiserId]),
        fields: JSON.stringify(["advertiser_id", "name", "balance", "currency", "status", "role", "owner_bc_id", "company"]),
      });
      item.advertiser_info = data.list ?? data;
    } catch (e) {
      item.advertiser_info_error = (e as Error).message;
    }
    out.push(item);
  }
  return { advertiser_id: advertiserId, results: out };
}

// ---------- 日耗 ----------
const dayOf = (v: unknown) => String(v ?? "").slice(0, 10);

async function fetchBasicSpend(token: string, advertiserId: string, start: string, end: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let page = 1; page <= 10; page++) {
    const data = await ttGet(token, "/report/integrated/get/", {
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: "AUCTION_ADVERTISER",
      dimensions: JSON.stringify(["advertiser_id", "stat_time_day"]),
      metrics: JSON.stringify(["spend"]),
      start_date: start,
      end_date: end,
      page: String(page),
      page_size: "1000",
    });
    const list = (data.list ?? []) as Array<Record<string, Record<string, unknown>>>;
    for (const r of list) {
      const d = dayOf(r.dimensions?.stat_time_day);
      out.set(d, (out.get(d) ?? 0) + (Number(r.metrics?.spend ?? 0) || 0));
    }
    const info = (data.page_info ?? {}) as Record<string, unknown>;
    if (!list.length || page >= Number(info.total_page ?? 1)) break;
  }
  return out;
}

async function fetchGmvMaxSpend(token: string, advertiserId: string, shopId: string, start: string, end: string): Promise<Map<string, number>> {
  const rows = await fetchReport(token, advertiserId, shopId, start, end, ["campaign_id", "stat_time_day"], {}, ["cost"]);
  const out = new Map<string, number>();
  for (const r of rows) {
    const d = dayOf((r.dimensions as Record<string, unknown> | undefined)?.stat_time_day);
    const v = Number((r.metrics as Record<string, unknown> | undefined)?.cost ?? 0) || 0;
    out.set(d, (out.get(d) ?? 0) + v);
  }
  return out;
}

const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------- actions ----------
async function actionList() {
  const db = admin();
  const [settings, conns, { data: snaps, error }, { data: ctry }] = await Promise.all([
    loadSettings(),
    loadConnections(),
    db.from("balance_alert_accounts").select("*"),
    db.from("advertiser_countries").select("advertiser_id,country,advertiser_name,active"),
  ]);
  if (error) throw new Error(error.message);
  const snapMap = new Map((snaps ?? []).map((s: Record<string, unknown>) => [String(s.advertiser_id), s]));
  const ctryMap = new Map((ctry ?? []).map((c: Record<string, unknown>) => [String(c.advertiser_id), c]));
  const labels = new Map<string, string[]>();
  for (const c of conns) for (const id of c.advertiser_ids ?? []) {
    const arr = labels.get(String(id)) ?? [];
    arr.push(c.label);
    labels.set(String(id), arr);
  }
  const accounts = allAdvertiserIds(conns).map((id) => {
    const s = (snapMap.get(id) ?? {}) as Record<string, unknown>;
    const c = (ctryMap.get(id) ?? {}) as Record<string, unknown>;
    return {
      advertiser_id: id,
      advertiser_name: (s.advertiser_name as string) ?? (c.advertiser_name as string) ?? null,
      country: (c.country as string) ?? null,
      connections: labels.get(id) ?? [],
      enabled: s.enabled === undefined ? true : !!s.enabled,
      currency: s.currency ?? null,
      balance: numOrNull(s.balance),
      balance_source: s.balance_source ?? null,
      avg_daily_spend: numOrNull(s.avg_daily_spend),
      valid_days: s.valid_days ?? null,
      window_start: s.window_start ?? null,
      window_end: s.window_end ?? null,
      daily: s.daily ?? null,
      days_left: numOrNull(s.days_left),
      error: s.error ?? null,
      checked_at: s.checked_at ?? null,
      last_alerted_at: s.last_alerted_at ?? null,
    };
  });
  return { settings, accounts };
}

async function actionRefresh(body: Record<string, unknown>) {
  const started = Date.now();
  const db = admin();
  const settings = await loadSettings();
  const conns = await loadConnections();
  const all = allAdvertiserIds(conns);
  const requested = Array.isArray(body.advertiser_ids) ? (body.advertiser_ids as unknown[]).map(String) : all;
  const ids = requested.filter((id) => all.includes(id));
  const wanted = new Set(ids);

  const { data: ctry } = await db.from("advertiser_countries").select("advertiser_id,shop_id,advertiser_name").in("advertiser_id", ids);
  const shopOf = new Map((ctry ?? []).map((c: Record<string, unknown>) => [String(c.advertiser_id), String(c.shop_id ?? "").trim()]));
  const nameOf = new Map((ctry ?? []).map((c: Record<string, unknown>) => [String(c.advertiser_id), (c.advertiser_name as string) ?? null]));

  const win = spendWindow();
  const { map: tkBalances, errors: balanceErrors } = await fetchBalances(conns, wanted);
  // ECO 后台优先：ECO 列表里有的户用 ECO 可用余额（totalBalance − frozenBalance），其余户走 TikTok 接口
  const { map: ecoMap, error: ecoError } = await fetchEcoBalances(win.start, win.end);
  if (ecoError) balanceErrors.push(`ECO: ${ecoError}`);
  const balances = new Map<string, BalanceInfo>();
  for (const id of ids) {
    const eco = ecoMap.get(id);
    const tk = tkBalances.get(id);
    if (eco && eco.available != null) {
      balances.set(id, {
        balance: eco.available,
        currency: eco.currency ?? tk?.currency ?? null,
        name: tk?.name ?? eco.name,
        source: `采用 ECO 后台可用余额｜ECO totalBalance=${eco.total} frozenBalance=${eco.frozen} consumption(${win.start}~${win.end})=${eco.consumption}｜TikTok：${tk?.source ?? "无"}`,
      });
    } else if (tk) {
      balances.set(id, {
        ...tk,
        source: tk.balance == null && ecoError ? `ECO 登录/拉取失败：${ecoError}｜${tk.source}` : tk.source,
      });
    }
  }

  const done: string[] = [];
  const failed: Array<{ advertiser_id: string; error: string }> = [];
  for (const id of ids) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const tokens = conns.filter((c) => (c.advertiser_ids ?? []).map(String).includes(id));
    const bal = balances.get(id);
    const notes: string[] = [];
    let basic: Map<string, number> | null = null;
    let gmv: Map<string, number> | null = null;
    for (const c of tokens) {
      if (basic) break;
      try { basic = await fetchBasicSpend(c.access_token, id, win.start, win.end); }
      catch (e) { notes.push(`BASIC[${c.label}]: ${(e as Error).message}`); }
    }
    const shop = shopOf.get(id);
    if (shop) {
      for (const c of tokens) {
        if (gmv) break;
        try { gmv = await fetchGmvMaxSpend(c.access_token, id, shop, win.start, win.end); }
        catch (e) { notes.push(`GMV Max[${c.label}]: ${(e as Error).message}`); }
      }
    }
    const spendOk = basic != null || gmv != null;
    const stats = spendOk
      ? computeSpendStats(win.dates, mergeDailySpend(basic ?? new Map(), gmv ?? new Map()), settings.abnormal_ratio)
      : null;
    const balance = bal?.balance ?? null;
    if (balance == null) notes.unshift(bal?.source ?? "未取到余额（两个余额接口都没返回该户）");
    const avg = stats?.avg_daily_spend ?? null;
    const row = {
      advertiser_id: id,
      advertiser_name: bal?.name ?? nameOf.get(id) ?? null,
      currency: bal?.currency ?? null,
      balance,
      balance_source: bal?.source ?? null,
      avg_daily_spend: avg,
      valid_days: stats?.valid_days ?? null,
      window_start: win.start,
      window_end: win.end,
      daily: stats?.days.map((d) => ({
        date: d.date,
        spend: Math.round(d.spend * 100) / 100,
        valid: d.valid,
        basic: basic?.get(d.date) ?? null,
        gmv_max: gmv?.get(d.date) ?? null,
      })) ?? null,
      days_left: daysLeft(balance, avg),
      error: notes.length ? notes.join("；").slice(0, 1000) : null,
      checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("balance_alert_accounts").upsert(row, { onConflict: "advertiser_id" });
    if (error) failed.push({ advertiser_id: id, error: error.message });
    else if (!spendOk || balance == null) failed.push({ advertiser_id: id, error: row.error ?? "" });
    done.push(id);
  }
  const remaining = ids.filter((id) => !done.includes(id));
  if (!remaining.length) {
    await db.from("balance_alert_settings").update({
      last_run_at: new Date().toISOString(),
      last_run_summary: { checked: done.length, failed: failed.length, balance_errors: balanceErrors },
    }).eq("id", 1);
  }
  return { done: done.length, remaining, failed, balance_errors: balanceErrors, window: { start: win.start, end: win.end } };
}

// 飞书消息：交互卡片（群机器人 webhook 支持 msg_type=interactive）。
// 每次都发（无预警也发完整列表）；卡片头颜色：有户用光 → 红，有户 < X → 黄，否则绿。
// 列表 = 开了监控的户，按正常日均倒序；列：账号 / 余额 / 日耗 / 可用天数（可用天数按 dayLevel 着色）。
async function actionBuildMessage(_body: Record<string, unknown>) {
  const { settings, accounts } = await actionList();
  const X = settings.threshold_days;
  const enabled = accounts
    .filter((a) => a.enabled)
    .sort((a, b) => (b.avg_daily_spend ?? -1) - (a.avg_daily_spend ?? -1));
  if (!enabled.length) return { send: false, alerts: 0, broken: 0 };
  const hits = enabled.filter((a) => shouldAlert(true, a.days_left, X));
  const usedUp = enabled.filter((a) => a.days_left != null && a.days_left <= 0);
  const idle = (a: (typeof accounts)[number]) =>
    Array.isArray(a.daily) && (a.daily as Array<{ spend: number }>).every((d) => !(d.spend > 0));
  const broken = enabled.filter((a) => a.days_left == null && a.error && !idle(a));
  const level = overallLevel(enabled.map((a) => a.days_left), X);

  const checked = enabled.map((a) => a.checked_at).filter(Boolean).sort().pop();
  const dataTime = checked ? new Date(String(checked)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
  const title = level === "red"
    ? `账户余额告警：${usedUp.length} 个账户已用光`
    : level === "yellow"
      ? `账户余额预警：${hits.length} 个账户可用不足 ${X} 天`
      : `账户余额正常：全部可用 ≥ ${X} 天`;

  const dayCell = (d: number | null) => {
    const lv = dayLevel(d, X);
    if (lv === "none") return "<font color='grey'>—</font>";
    const v = `**${fmt(d, 1)}**`;
    if (lv === "red") return `🔴 <font color='red'>${v}</font>`;
    if (lv === "yellow") return `🟡 <font color='orange'>${v}</font>`;
    return `🟢 <font color='green'>${v}</font>`;
  };
  const cur = (c: unknown) => (c && c !== "USD" ? ` ${c}` : "");
  const row = (cells: string[], header = false) => ({
    tag: "column_set",
    flex_mode: "none",
    background_style: header ? "grey" : "default",
    columns: cells.map((content, i) => ({
      tag: "column",
      width: "weighted",
      weight: i === 0 ? 3 : 2,
      vertical_align: "center",
      elements: [{ tag: "markdown", content, text_align: i === 0 ? "left" : "right" }],
    })),
  });

  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: [
        `**日耗监控天数**：${X}天`,
        `**当前账户可用天数列表**`,
        `**数据时间**：${dataTime}`,
      ].join("\n"),
    },
    { tag: "hr" },
    row(["**账号**", "**余额**", "**日耗**", "**可用天数**"], true),
    ...enabled.map((a) =>
      row([
        a.advertiser_name ?? a.advertiser_id,
        a.balance == null ? "—" : `${fmt(a.balance)}${cur(a.currency)}`,
        a.avg_daily_spend == null ? "0.00" : fmt(a.avg_daily_spend),
        dayCell(a.days_left),
      ])
    ),
  ];
  if (broken.length) {
    elements.push({ tag: "hr" }, {
      tag: "markdown",
      content: `**⚠ ${broken.length} 个账户未能算出可用天数**\n` +
        broken.slice(0, 8).map((a) => `- ${a.advertiser_name ?? a.advertiser_id}：${String(a.error).slice(0, 80)}`).join("\n"),
    });
  }
  elements.push({
    tag: "note",
    elements: [{
      tag: "plain_text",
      content: `🔴 可用 < ${X} 天　🟡 ${X}~${X + NEAR_DAYS} 天　🟢 ≥ ${X + NEAR_DAYS} 天｜日耗 = 近10个完整自然日正常日均（剔除日耗 0 / 低于中位数 ${Math.round(settings.abnormal_ratio * 100)}% 的天）`,
    }],
  });

  const card = {
    config: { wide_screen_mode: true },
    header: { template: level, title: { tag: "plain_text", content: title } },
    elements,
  };

  // lines 保留给旧版服务端路由（纯文本兜底）
  const lines = [
    `日耗监控天数：${X}天`, "当前账户可用天数列表", `数据时间：${dataTime}`, "",
    ...enabled.map((a) => `${a.advertiser_name ?? a.advertiser_id}｜余额 ${a.balance == null ? "—" : fmt(a.balance)}｜日耗 ${fmt(a.avg_daily_spend ?? 0)}｜可用 ${a.days_left == null ? "—" : fmt(a.days_left, 1)} 天`),
  ];

  return {
    send: true,
    title,
    lines,
    card,
    level,
    alert_ids: hits.map((a) => a.advertiser_id),
    alerts: hits.length,
    broken: broken.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "list");
    const isCron = await cronAuthed(req);
    if (!(isCron && ["refresh", "build_message", "mark_alerted"].includes(action))) {
      await checkAdminPasscode(req, "settings");
    }
    const db = admin();
    switch (action) {
      case "list":
        return json(await actionList());
      case "save_settings": {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.threshold_days !== undefined) {
          const x = Number(body.threshold_days);
          if (!(x > 0)) throw new Error("预警天数必须 > 0");
          patch.threshold_days = x;
        }
        if (body.abnormal_ratio !== undefined) {
          const r = Number(body.abnormal_ratio);
          if (!(r >= 0 && r < 1)) throw new Error("异常日比例必须在 0~1 之间");
          patch.abnormal_ratio = r;
        }
        if (body.feishu_chat_id !== undefined) patch.feishu_chat_id = String(body.feishu_chat_id || "") || null;
        if (body.feishu_chat_name !== undefined) patch.feishu_chat_name = String(body.feishu_chat_name || "") || null;
        const { error } = await db.from("balance_alert_settings").upsert({ id: 1, ...patch });
        if (error) throw new Error(error.message);
        return json({ ok: true, settings: await loadSettings() });
      }
      case "toggle": {
        const id = String(body.advertiser_id ?? "");
        if (!id) throw new Error("缺少 advertiser_id");
        const { error } = await db.from("balance_alert_accounts")
          .upsert({ advertiser_id: id, enabled: !!body.enabled, updated_at: new Date().toISOString() }, { onConflict: "advertiser_id" });
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }
      case "refresh":
        return json(await actionRefresh(body));
      case "eco_status": {
        const dev = await getDeviceId();
        return json({ configured: ecoConfigured(), device_saved: !!dev.id, device_at: dev.at });
      }
      case "eco_2fa_send": {
        await requireAdmin(req);
        return json(await eco2faSend(body.method ? Number(body.method) : undefined));
      }
      case "eco_2fa_verify": {
        await requireAdmin(req);
        const code = String(body.code ?? "").trim();
        if (!code) throw new Error("请输入验证码");
        return json(await eco2faVerify(Number(body.method ?? 1), code));
      }
      case "debug_eco": {
        // 只读诊断：登录 ECO 并返回前 50 个户的余额字段（不含 token）
        const win = spendWindow();
        const token = await ecoLogin();
        const list = await ecoListAccounts(token, win.start, win.end);
        return json({ ok: true, window: win, count: list.length, accounts: list });
      }
      case "debug_balance": {
        const id = String(body.advertiser_id ?? "");
        if (!id) throw new Error("缺少 advertiser_id");
        return json(await debugBalance(await loadConnections(), id));
      }
      case "build_message":
        return json(await actionBuildMessage(body));
      case "mark_alerted": {
        const ids = Array.isArray(body.advertiser_ids) ? (body.advertiser_ids as unknown[]).map(String) : [];
        if (ids.length) {
          const { error } = await db.from("balance_alert_accounts")
            .update({ last_alerted_at: new Date().toISOString() }).in("advertiser_id", ids);
          if (error) throw new Error(error.message);
        }
        return json({ ok: true });
      }
      default:
        throw new Error(`未知 action: ${action}`);
    }
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("balance-alert", e);
    return json({ error: (e as Error).message }, status);
  }
});
