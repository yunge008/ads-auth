// 账户余额预警（设置 → 账户余额预警）。
//
// actions:
//   list                           → { settings, accounts }（读库里快照，不调 TikTok）
//   save_settings {threshold_days?, abnormal_ratio?, feishu_chat_id?, feishu_chat_name?}
//   toggle {advertiser_id, enabled}
//   refresh {advertiser_ids?}      → 现拉余额 + 近 10 天日耗，写快照；超时间预算返回 remaining 让调用方续跑
//   notify {force?}                → 把「开关开 且 可用天数 < X」的户发到飞书群（force=true 时无预警也发一条，用于测试）
//   list_chats                     → 机器人所在的飞书群（供选择 chat_id）
//
// 鉴权：口令 + settings tab；cron（x-cron-key）只放行 refresh / notify。
// TikTok 调用一律走 _shared/tiktok.ts 的 ttGet（限速 + 退避）。
import { corsHeaders, getTenantAccessToken } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { ttGet } from "../_shared/tiktok.ts";
import { fetchReport } from "../_shared/gmv-max-report.ts";
import {
  computeSpendStats,
  DEFAULT_ABNORMAL_RATIO,
  daysLeft,
  mergeDailySpend,
  shouldAlert,
  spendWindow,
} from "../_shared/balance-alert.ts";

const FEISHU_BASE = "https://open.feishu.cn/open-apis";
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
// 优先 BC 接口 /advertiser/balance/get/ 的 valid_account_balance（可用余额），
// 拿不到再退回 /advertiser/info/ 的 balance。
async function fetchBalances(conns: ConnRow[], wanted: Set<string>): Promise<{ map: Map<string, BalanceInfo>; errors: string[] }> {
  const map = new Map<string, BalanceInfo>();
  const errors: string[] = [];
  for (const c of conns) {
    if (!c.bc_id) continue;
    try {
      for (let page = 1; page <= 50; page++) {
        const data = await ttGet(c.access_token, "/advertiser/balance/get/", {
          bc_id: c.bc_id, page: String(page), page_size: "100",
        });
        const list = (data.advertiser_account_list ?? data.list ?? []) as Array<Record<string, unknown>>;
        for (const it of list) {
          const id = String(it.advertiser_id ?? "");
          if (!id || !wanted.has(id) || map.has(id)) continue;
          const valid = numOrNull(it.valid_account_balance);
          const total = numOrNull(it.account_balance);
          map.set(id, {
            balance: valid ?? total,
            currency: it.currency ? String(it.currency) : null,
            name: it.advertiser_name ? String(it.advertiser_name) : null,
            source: valid != null ? "bc.valid_account_balance" : total != null ? "bc.account_balance" : "bc(无余额字段)",
          });
        }
        const info = (data.page_info ?? {}) as Record<string, unknown>;
        const totalPage = Number(info.total_page ?? 0);
        if (!list.length || !totalPage || page >= totalPage) break;
      }
    } catch (e) {
      errors.push(`[${c.label}] advertiser/balance/get: ${(e as Error).message}`);
    }
  }
  // 兜底：advertiser/info balance
  for (const c of conns) {
    const ids = (c.advertiser_ids ?? []).map(String).filter((id) => wanted.has(id) && !(map.get(id)?.balance != null));
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
          const bal = numOrNull(it.balance);
          if (!id || bal == null) continue;
          map.set(id, {
            balance: bal,
            currency: it.currency ? String(it.currency) : map.get(id)?.currency ?? null,
            name: it.name ? String(it.name) : map.get(id)?.name ?? null,
            source: "advertiser/info.balance",
          });
        }
      } catch (e) {
        errors.push(`[${c.label}] advertiser/info: ${(e as Error).message}`);
      }
    }
  }
  return { map, errors };
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

// ---------- 飞书 ----------
async function sendFeishu(chatId: string, title: string, lines: string[]) {
  const token = await getTenantAccessToken();
  const r = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "post",
      content: JSON.stringify({ zh_cn: { title, content: lines.map((t) => [{ tag: "text", text: t }]) } }),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`飞书发送失败 code=${j.code}: ${j.msg ?? r.status}`);
}

async function listChats() {
  const token = await getTenantAccessToken();
  const chats: Array<{ chat_id: string; name: string }> = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const u = new URL(`${FEISHU_BASE}/im/v1/chats`);
    u.searchParams.set("page_size", "100");
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 0) throw new Error(`读取飞书群列表失败 code=${j.code}: ${j.msg ?? r.status}`);
    for (const it of (j.data?.items ?? []) as Array<Record<string, unknown>>) {
      chats.push({ chat_id: String(it.chat_id), name: String(it.name ?? "") });
    }
    if (!j.data?.has_more) break;
    pageToken = String(j.data?.page_token ?? "");
  }
  return chats;
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

  const { map: balances, errors: balanceErrors } = await fetchBalances(conns, wanted);
  const win = spendWindow();

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
    if (balance == null) notes.unshift("未取到余额");
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

async function actionNotify(body: Record<string, unknown>) {
  const { settings, accounts } = await actionList();
  if (!settings.feishu_chat_id) throw new Error("未设置飞书群（chat_id），请先在「账户余额预警」里选择群");
  const X = settings.threshold_days;
  const hits = accounts
    .filter((a) => shouldAlert(a.enabled, a.days_left, X))
    .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0));
  const broken = accounts.filter((a) => a.enabled && (a.days_left == null) && a.error);
  if (!hits.length && !broken.length && !body.force) return { sent: false, alerts: 0 };

  const lines: string[] = [];
  lines.push(`规则：可用余额 ÷ 近10天正常日均 < ${X} 天（已剔除日耗为 0 / 低于中位数 ${Math.round(settings.abnormal_ratio * 100)}% 的异常日）`);
  if (hits.length) {
    lines.push("");
    for (const a of hits) {
      lines.push(
        `⚠ ${a.advertiser_name ?? a.advertiser_id}${a.country ? `（${a.country}）` : ""}  ID ${a.advertiser_id}`,
        `   可用余额 ${fmt(a.balance)} ${a.currency ?? ""} ｜ 正常日均 ${fmt(a.avg_daily_spend)}（${a.valid_days}/10 天）｜ 可用 ${fmt(a.days_left, 1)} 天`,
      );
    }
  } else {
    lines.push("", "当前没有低于阈值的账户。");
  }
  if (broken.length) {
    lines.push("", `另有 ${broken.length} 个已开启预警的账户本次未能算出可用天数：`);
    for (const a of broken.slice(0, 10)) lines.push(`   ${a.advertiser_name ?? a.advertiser_id}：${String(a.error).slice(0, 120)}`);
    if (broken.length > 10) lines.push(`   ……共 ${broken.length} 个，详见「设置 → 账户余额预警」`);
  }
  const checked = accounts.map((a) => a.checked_at).filter(Boolean).sort().pop();
  if (checked) lines.push("", `数据时间：${new Date(String(checked)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);

  await sendFeishu(settings.feishu_chat_id, hits.length ? `账户余额预警：${hits.length} 个账户不足 ${X} 天` : "账户余额预警", lines);
  if (hits.length) {
    await admin().from("balance_alert_accounts")
      .update({ last_alerted_at: new Date().toISOString() })
      .in("advertiser_id", hits.map((a) => a.advertiser_id));
  }
  return { sent: true, alerts: hits.length, broken: broken.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "list");
    const isCron = await cronAuthed(req);
    if (!(isCron && (action === "refresh" || action === "notify"))) {
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
      case "notify":
        return json(await actionNotify(body));
      case "list_chats":
        return json({ chats: await listChats() });
      default:
        throw new Error(`未知 action: ${action}`);
    }
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("balance-alert", e);
    return json({ error: (e as Error).message }, status);
  }
});
