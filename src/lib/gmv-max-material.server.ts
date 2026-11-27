// GMV MAX 素材数据自动抓取（归因用）—— 阶段 A：按 站点×月 从接口取数落库，再与已上传的表逐项对账。
// 规则：docs/AUTO_DATA_PLAN.md 第二节。数据写进 gmv_max_material_* 独立表，不进归因计算。
//
// TikTok 调用复用 supabase/functions/_shared 的 ttGet / fetchReport / fetchCampaigns（限速 + 退避 + 无效 metric 剔除）。
// 运行环境是 Lovable 服务端路由（Cloudflare Workers）：单个请求的外部调用数有限，
// 所以拆成「step」分步续跑：每步最多 STEP_TT_CALLS 次 TikTok 调用，进度存在 batch.advertisers。
import process from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ttGet } from "../../supabase/functions/_shared/tiktok.ts";
import {
  fetchCampaigns,
  fetchReport,
  type RawRow,
} from "../../supabase/functions/_shared/gmv-max-report.ts";
import { splitWindows } from "../../supabase/functions/_shared/gmv-max-export.ts";

const STEP_TT_CALLS = 30;
const STEP_SOFT_MS = 45_000;

// 素材查询的 metric（与 gmv-max-sync 第 1 阶段默认 metric 同源，去掉视频完播率）
const MONEY_METRICS = [
  "cost",
  "orders",
  "gross_revenue",
  "product_impressions",
  "product_clicks",
  "currency",
  "tt_account_name",
  "tt_account_authorization_type",
  "shop_content_type",
];
// 元数据 metric（与 gmv-max-sync 第 3 阶段同源）。发布时间的确切字段名接口文档未公开：三个候选，无效的由 fetchReport 自动剔除。
const POSTED_CANDIDATES = ["item_posted_time", "video_posted_time", "post_time"];
const META_METRICS = ["title", ...POSTED_CANDIDATES];

export function adminDb(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 口令校验：借 attribution-upload 的 verifyPasscode（归因管理页权限）；通过时它会因未知 action 返回 400。 */
export async function checkAttributionPasscode(request: Request): Promise<string | null> {
  const passcode = request.headers.get("x-admin-passcode") ?? "";
  if (!passcode) return "未登录";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/attribution-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "x-admin-passcode": passcode,
      "x-admin-name": request.headers.get("x-admin-name") ?? "",
    },
    body: JSON.stringify({ action: "__auth_check" }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (r.status === 400 && /未知 action/.test(j.error ?? "")) return null;
  return j.error ?? `鉴权失败 HTTP ${r.status}`;
}

// ───────────────────────── 类型 ─────────────────────────
type Money = { cost: number; gross_revenue: number; orders: number };
type AdvState = {
  advertiser_id: string;
  name: string;
  active: boolean;
  shop_id: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  error?: string;
  pending_campaigns?: string[];
  campaign_totals?: Record<string, Money>;
  campaign_names?: Record<string, string>;
  rows?: number;
  zero_rows?: number;
  errors?: string[];
};
type Fields = {
  money_metrics_seen?: string[];
  meta_metrics_seen?: string[];
  posted_field?: string | null;
  content_types?: Record<string, number>;
  currencies?: Record<string, number>;
  item_id_samples?: Record<string, string[]>; // 每种内容类型的 item_id 原值样本
  meta_conflicts?: number; // 同一 VID 多次返回的达人名/内容类型不一致次数
  warnings?: string[];
  // 元数据（标题/发布时间）查询整体被接口拒绝时的原文；之后不再重复请求
  meta_unavailable?: string;
  // 每种内容类型第一行的 metrics 原样（诊断字段名与取值，不含个人信息）
  sample_metrics?: Record<string, Record<string, unknown>>;
};
type Batch = {
  id: string;
  country: string;
  month: string;
  status: string;
  advertisers: AdvState[];
  fields: Fields;
  report: unknown;
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v == null ? "" : String(v));
const isZero = (m: Money) => m.cost === 0 && m.gross_revenue === 0 && m.orders === 0;

/** 与 src/lib/adExcel.ts normCreativeType 同规则：只做精确匹配，认不出来的保留原文（并在 fields.warnings 提示） */
export function normContentType(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "video" || s === "视频") return "video";
  if (s === "product_card" || s === "product card" || s === "商品卡片" || s === "商品卡")
    return "product_card";
  if (s === "live" || s === "直播") return "live";
  return raw.trim();
}

function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}

// ───────────────────────── 动作 ─────────────────────────
export async function startBatch(
  db: SupabaseClient,
  country: string,
  month: string,
  operator: string,
) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
  if (!country) throw new Error("country 必填");
  // 范围 = 设置里登记在该站点下的全部广告户（含未启用）：旧户/新户的消耗都要抓到。
  // 未在设置里登记、却在该店铺有消耗的户，这一步发现不了 —— 见文档「已知缺口」。
  const { data, error } = await db
    .from("advertiser_countries")
    .select("advertiser_id, advertiser_name, active, shop_id")
    .eq("country", country);
  if (error) throw new Error(error.message);
  const advs: AdvState[] = (data ?? []).map((r) => ({
    advertiser_id: String(r.advertiser_id),
    name: str(r.advertiser_name),
    active: !!r.active,
    shop_id: str(r.shop_id),
    status: "PENDING",
  }));
  if (!advs.length) throw new Error(`设置里没有站点 ${country} 的广告户`);
  const { data: b, error: e2 } = await db
    .from("gmv_max_material_batches")
    .insert({ country, month, triggered_by: operator || null, advertisers: advs, fields: {} })
    .select("id")
    .single();
  if (e2) throw new Error(e2.message);
  return { batch_id: b.id as string, advertisers: advs.length };
}

async function loadBatch(db: SupabaseClient, id: string): Promise<Batch> {
  const { data, error } = await db
    .from("gmv_max_material_batches")
    .select("id, country, month, status, advertisers, fields, report")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("批次不存在");
  return data as Batch;
}

/** 跑一步：处理第一个未完成的广告户，最多 STEP_TT_CALLS 次 TikTok 调用。前端循环调用直到 done=true。 */
export async function stepBatch(db: SupabaseClient, batchId: string) {
  const started = Date.now();
  const batch = await loadBatch(db, batchId);
  if (batch.status !== "RUNNING") return { done: true, status: batch.status };
  const fields = batch.fields ?? {};
  const adv = batch.advertisers.find((a) => a.status === "PENDING" || a.status === "RUNNING");
  if (!adv) {
    await db
      .from("gmv_max_material_batches")
      .update({ status: "READY", finished_at: new Date().toISOString() })
      .eq("id", batchId);
    return { done: true, status: "READY" };
  }

  let calls = 0;
  const budgetLeft = () => calls < STEP_TT_CALLS && Date.now() - started < STEP_SOFT_MS;
  const get: typeof ttGet = (...args) => {
    calls++;
    return ttGet(...args);
  };
  const [start, end] = monthRange(batch.month);

  try {
    if (!adv.shop_id) throw new Error("设置里没有填该户的店铺 ID");
    const token = await pickToken(db, adv.advertiser_id, get);

    if (adv.status === "PENDING") {
      // 1) campaign 级合计（不带 campaign 过滤，含已删除 campaign）= 对账基准 + 待处理 campaign 列表
      const totals: Record<string, Money> = {};
      for (const r of await fetchReport(
        token,
        adv.advertiser_id,
        adv.shop_id,
        start,
        end,
        ["campaign_id"],
        {},
        ["cost", "orders", "gross_revenue"],
        get,
      )) {
        const id = str((r.dimensions as Record<string, unknown>)?.campaign_id);
        const m = (r.metrics ?? {}) as Record<string, unknown>;
        if (id)
          totals[id] = {
            cost: num(m.cost),
            gross_revenue: num(m.gross_revenue),
            orders: num(m.orders),
          };
      }
      const names: Record<string, string> = {};
      for (const c of await fetchCampaigns(token, adv.advertiser_id, get)) names[c.id] = c.name;
      // 2) 每天消耗（换户检测用）：带 stat_time_day 单次最多 30 天
      const daily = new Map<string, Money>();
      for (const [s, e] of splitWindows(start, end)) {
        for (const r of await fetchReport(
          token,
          adv.advertiser_id,
          adv.shop_id,
          s,
          e,
          ["campaign_id", "stat_time_day"],
          {},
          ["cost", "orders", "gross_revenue"],
          get,
        )) {
          const d = str((r.dimensions as Record<string, unknown>)?.stat_time_day).slice(0, 10);
          const m = (r.metrics ?? {}) as Record<string, unknown>;
          if (!d) continue;
          const t = daily.get(d) ?? { cost: 0, gross_revenue: 0, orders: 0 };
          t.cost += num(m.cost);
          t.gross_revenue += num(m.gross_revenue);
          t.orders += num(m.orders);
          daily.set(d, t);
        }
      }
      if (daily.size) {
        const { error } = await db.from("gmv_max_adv_daily").upsert(
          [...daily].map(([d, m]) => ({
            advertiser_id: adv.advertiser_id,
            stat_date: d,
            country: batch.country,
            ...m,
            fetched_at: new Date().toISOString(),
          })),
          { onConflict: "advertiser_id,stat_date" },
        );
        if (error) throw new Error(`写每日消耗失败：${error.message}`);
      }
      adv.campaign_totals = totals;
      adv.campaign_names = names;
      // 只处理本月有数据的 campaign（合计全 0 的跳过，节省调用）
      adv.pending_campaigns = Object.keys(totals)
        .filter((id) => !isZero(totals[id]))
        .sort();
      adv.rows = 0;
      adv.zero_rows = 0;
      adv.errors = [];
      adv.status = "RUNNING";
    }

    // 3) 逐 campaign 取 商品组 → 素材（VID）明细；一个 campaign 完整取完才落库并出队，失败可重跑该步
    while (adv.pending_campaigns!.length && budgetLeft()) {
      const cid = adv.pending_campaigns![0];
      const rows = await fetchCampaignMaterial(token, adv, cid, start, end, get, fields);
      const keep = rows.filter((r) => !isZero(r));
      adv.zero_rows = (adv.zero_rows ?? 0) + (rows.length - keep.length);
      // 先删后插，保证同一 campaign 重跑不重复
      const del = await db
        .from("gmv_max_material_agg")
        .delete()
        .eq("batch_id", batchId)
        .eq("advertiser_id", adv.advertiser_id)
        .eq("campaign_id", cid);
      if (del.error) throw new Error(del.error.message);
      for (let i = 0; i < keep.length; i += 500) {
        const { error } = await db
          .from("gmv_max_material_agg")
          .insert(keep.slice(i, i + 500).map((r) => ({ batch_id: batchId, ...r })));
        if (error) throw new Error(`写素材明细失败：${error.message}`);
      }
      adv.rows = (adv.rows ?? 0) + keep.length;
      adv.pending_campaigns!.shift();
    }
    if (!adv.pending_campaigns!.length) adv.status = "DONE";
  } catch (e) {
    const msg = (e as Error).message;
    // 预算内单个 campaign 没取完不算失败：下一步从同一 campaign 重来
    adv.status = "FAILED";
    adv.error = msg;
  }

  await saveBatch(db, batch, fields);
  const left = batch.advertisers.filter((a) => a.status === "PENDING" || a.status === "RUNNING");
  return {
    done: false,
    tt_calls: calls,
    advertiser: {
      id: adv.advertiser_id,
      name: adv.name,
      status: adv.status,
      error: adv.error ?? null,
      pending_campaigns: adv.pending_campaigns?.length ?? null,
      rows: adv.rows ?? 0,
    },
    advertisers_left: left.length,
  };
}

/** 把失败的广告户放回队列（已取完的 campaign 不重取：pending_campaigns 保留）。 */
export async function retryFailed(db: SupabaseClient, batchId: string) {
  const batch = await loadBatch(db, batchId);
  let n = 0;
  for (const a of batch.advertisers) {
    if (a.status !== "FAILED") continue;
    a.status = a.pending_campaigns ? "RUNNING" : "PENDING";
    delete a.error;
    n++;
  }
  const { error } = await db
    .from("gmv_max_material_batches")
    .update({ advertisers: batch.advertisers, status: "RUNNING", finished_at: null })
    .eq("id", batchId);
  if (error) throw new Error(error.message);
  return { requeued: n };
}

async function saveBatch(db: SupabaseClient, batch: Batch, fields: Fields) {
  const { error } = await db
    .from("gmv_max_material_batches")
    .update({ advertisers: batch.advertisers, fields })
    .eq("id", batch.id);
  if (error) throw new Error(error.message);
}

async function pickToken(
  db: SupabaseClient,
  advertiserId: string,
  get: typeof ttGet,
): Promise<string> {
  const { data, error } = await db
    .from("tiktok_connections")
    .select("access_token, created_at")
    .contains("advertiser_ids", [advertiserId]);
  if (error) throw new Error(error.message);
  const conns = ((data ?? []) as { access_token: string; created_at: string }[]).sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  if (!conns.length)
    throw new Error("没有任何授权连接包含该广告户（旧户被移出 BC 后接口取不到历史数据）");
  let last = "";
  for (const c of conns) {
    try {
      await get(c.access_token, "/gmv_max/campaign/get/", {
        advertiser_id: advertiserId,
        filtering: JSON.stringify({ gmv_max_promotion_types: ["PRODUCT_GMV_MAX"] }),
        page: "1",
        page_size: "1",
      });
      return c.access_token;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(`${conns.length} 条授权都无法读取该户：${last}`);
}

type MatRow = Money & {
  advertiser_id: string;
  campaign_id: string;
  product_id: string;
  item_id: string;
  content_type_raw: string | null;
  creative_type: string;
  account_name: string | null;
  title: string | null;
  posted_raw: string | null;
  currency: string | null;
  impressions: number | null;
  clicks: number | null;
};

async function fetchCampaignMaterial(
  token: string,
  adv: AdvState,
  cid: string,
  start: string,
  end: string,
  get: typeof ttGet,
  fields: Fields,
): Promise<MatRow[]> {
  const groups = await fetchReport(
    token,
    adv.advertiser_id,
    adv.shop_id,
    start,
    end,
    ["campaign_id", "item_group_id"],
    { campaign_ids: [cid] },
    ["cost", "orders", "gross_revenue"],
    get,
  );
  const groupIds = [
    ...new Set(
      groups
        .map((g) => str((g.dimensions as Record<string, unknown>)?.item_group_id))
        .filter(Boolean),
    ),
  ];
  const byKey = new Map<string, MatRow>();
  const seenMoney = new Set(fields.money_metrics_seen ?? []);
  const seenMeta = new Set(fields.meta_metrics_seen ?? []);
  fields.content_types ??= {};
  fields.currencies ??= {};
  fields.item_id_samples ??= {};
  fields.meta_conflicts ??= 0;

  for (let i = 0; i < groupIds.length; i += 100) {
    const batch = groupIds.slice(i, i + 100);
    // 不带 stat_time_day：整月一次查（gmv-max-sync 第 3 阶段同类查询用过 365 天区间）
    const money: RawRow[] = await fetchReport(
      token,
      adv.advertiser_id,
      adv.shop_id,
      start,
      end,
      ["campaign_id", "item_group_id", "item_id"],
      { campaign_ids: [cid], item_group_ids: batch },
      MONEY_METRICS,
      get,
    );
    for (const r of money) {
      const d = (r.dimensions ?? {}) as Record<string, unknown>;
      const m = (r.metrics ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(m)) seenMoney.add(k);
      const pid = str(d.item_group_id),
        item = str(d.item_id);
      const key = `${pid}|${item}`;
      const ctRaw = m.shop_content_type == null ? null : str(m.shop_content_type);
      const ct = normContentType(ctRaw ?? "");
      const prev = byKey.get(key);
      if (prev) {
        // 同一 (商品, item) 在一次查询里不应重复；出现就累加并计冲突，不静默覆盖
        prev.cost += num(m.cost);
        prev.gross_revenue += num(m.gross_revenue);
        prev.orders += num(m.orders);
        if (
          prev.account_name !== (m.tt_account_name == null ? null : str(m.tt_account_name)) ||
          prev.content_type_raw !== ctRaw
        )
          fields.meta_conflicts!++;
        continue;
      }
      fields.content_types![ctRaw ?? "(null)"] =
        (fields.content_types![ctRaw ?? "(null)"] ?? 0) + 1;
      const cur = m.currency == null ? "(null)" : str(m.currency);
      fields.currencies![cur] = (fields.currencies![cur] ?? 0) + 1;
      fields.sample_metrics ??= {};
      fields.sample_metrics[ctRaw ?? "(null)"] ??= m;
      const samples = (fields.item_id_samples![ct] ??= []);
      if (samples.length < 5 && !samples.includes(item)) samples.push(item);
      byKey.set(key, {
        advertiser_id: adv.advertiser_id,
        campaign_id: str(d.campaign_id) || cid,
        product_id: pid,
        item_id: item,
        content_type_raw: ctRaw,
        creative_type: ct,
        account_name: m.tt_account_name == null ? null : str(m.tt_account_name),
        title: null,
        posted_raw: null,
        currency: m.currency == null ? null : str(m.currency),
        cost: num(m.cost),
        gross_revenue: num(m.gross_revenue),
        orders: Math.round(num(m.orders)),
        impressions: m.product_impressions == null ? null : num(m.product_impressions),
        clicks: m.product_clicks == null ? null : num(m.product_clicks),
      });
    }
    fields.money_metrics_seen = [...seenMoney].sort();
    // 元数据只查有钱的组（全 0 行最终不落库）
    const moneyGroups = new Set(
      [...byKey.values()]
        .filter((r) => !isZero(r) && batch.includes(r.product_id))
        .map((r) => r.product_id),
    );
    if (!moneyGroups.size || fields.meta_unavailable) continue;
    // 实测 2026-11-25（VN/JP）：title 与三个发布时间候选全部被判 Invalid metric —— 接口没有这些字段。
    // 不能因此让整户失败：记下原文、之后不再请求，对账报告里显式警告。
    let meta: RawRow[] = [];
    try {
      meta = await fetchReport(
        token,
        adv.advertiser_id,
        adv.shop_id,
        start,
        end,
        ["item_group_id", "item_id"],
        { campaign_ids: [cid], item_group_ids: [...moneyGroups] },
        META_METRICS,
        get,
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (!/Invalid metric/i.test(msg)) throw e;
      fields.meta_unavailable = msg;
      continue;
    }
    for (const r of meta) {
      const d = (r.dimensions ?? {}) as Record<string, unknown>;
      const m = (r.metrics ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(m)) seenMeta.add(k);
      const row = byKey.get(`${str(d.item_group_id)}|${str(d.item_id)}`);
      if (!row) continue;
      row.title = m.title == null ? null : str(m.title);
      const pf = POSTED_CANDIDATES.find((k) => m[k] != null && str(m[k]) !== "");
      if (pf) {
        row.posted_raw = str(m[pf]);
        fields.posted_field = pf;
      }
    }
  }
  fields.money_metrics_seen = [...seenMoney].sort();
  fields.meta_metrics_seen = [...seenMeta].sort();
  return [...byKey.values()];
}

// ───────────────────────── 对账 ─────────────────────────
type Side = Money & { rows: number };
const addTo = (t: Side, m: Money) => {
  t.cost += m.cost;
  t.gross_revenue += m.gross_revenue;
  t.orders += m.orders;
  t.rows++;
};
const side = (): Side => ({ cost: 0, gross_revenue: 0, orders: 0, rows: 0 });
const r2 = (v: number) => Math.round(v * 1000) / 1000;
const round = (s: Side) => ({
  cost: r2(s.cost),
  gross_revenue: r2(s.gross_revenue),
  orders: s.orders,
  rows: s.rows,
});

async function readAll<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: raw, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    const data = raw as T[] | null;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * 接口 vs 上传表 对账。比较键：
 * - 视频：内容类型 + VID + 商品 ID（达人名、发布时间作为属性逐值比，不进键）
 * - 商品卡片 / 直播 / 其他：内容类型 + 商品 ID（上传表这些行 VID 为空；接口 item_id 原值见 fields.item_id_samples）
 * 只比「花费/GMV/订单任一非 0」的行；两边的全 0 行只计数。
 */
export async function reconcileBatch(db: SupabaseClient, batchId: string) {
  const batch = await loadBatch(db, batchId);
  const { data: ups, error: ue } = await db
    .from("ad_uploads")
    .select("id, file_name, row_count, total_cost, total_revenue, status")
    .eq("country", batch.country)
    .eq("month", batch.month)
    .eq("status", "READY");
  if (ue) throw new Error(ue.message);
  const uploads = (ups ?? []) as {
    id: string;
    file_name: string;
    row_count: number;
    total_cost: number;
    total_revenue: number;
  }[];

  type URow = {
    upload_id: string;
    vid: string;
    account_name: string;
    product_id: string;
    creative_type: string;
    currency: string;
    posted_at: string | null;
    cost: number;
    gross_revenue: number;
    orders: number;
  };
  const uRows: URow[] = [];
  const uploadInfo: Record<string, unknown>[] = [];
  for (const u of uploads) {
    const rows = await readAll<URow>((f, t) =>
      db
        .from("ad_upload_agg")
        .select(
          "upload_id, vid, account_name, product_id, creative_type, currency, posted_at, cost, gross_revenue, orders",
        )
        .eq("upload_id", u.id)
        .or("cost.neq.0,gross_revenue.neq.0,orders.neq.0")
        .order("id")
        .range(f, t),
    );
    const { count } = await db
      .from("ad_upload_agg")
      .select("id", { count: "exact", head: true })
      .eq("upload_id", u.id);
    uRows.push(...rows);
    uploadInfo.push({
      file_name: u.file_name,
      row_count: u.row_count,
      agg_rows: count ?? null,
      nonzero_agg_rows: rows.length,
      truncated_100k: u.row_count === 100000,
    });
  }
  // —— 分卷配对 ——
  // 分卷 .1/.2 = 独立广告户（现行归因 skill 口径）。上传表不带广告户 ID，只能按金额配对：
  // 每个抓取成功且有消耗的户，找 花费 与其 campaign 级合计相差 < 2% 的分卷（取最接近的）。
  // 有户抓取失败时，只拿配上对的分卷参与对账，没配上的分卷列为「排除」并写明原因 —— 不静默丢弃。
  const upCost = new Map<string, number>();
  for (const r of uRows) upCost.set(r.upload_id, (upCost.get(r.upload_id) ?? 0) + num(r.cost));
  const pairs: Record<string, string> = {}; // upload_id → advertiser_id
  for (const adv of batch.advertisers) {
    if (adv.status !== "DONE") continue;
    const c = Object.values(adv.campaign_totals ?? {}).reduce((x, m) => x + m.cost, 0);
    if (c <= 0) continue;
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const u of uploads) {
      if (pairs[u.id]) continue;
      const d = Math.abs((upCost.get(u.id) ?? 0) - c) / c;
      if (d < 0.02 && d < bestDiff) {
        best = u.id;
        bestDiff = d;
      }
    }
    if (best) pairs[best] = adv.advertiser_id;
  }
  const anyFailed = batch.advertisers.some((a) => a.status === "FAILED");
  const usedUploads = new Set(uploads.filter((u) => !anyFailed || pairs[u.id]).map((u) => u.id));
  for (const info of uploadInfo) {
    const u = uploads.find((x) => x.file_name === info.file_name)!;
    const adv = batch.advertisers.find((a) => a.advertiser_id === pairs[u.id]);
    info.nonzero_cost = r2(upCost.get(u.id) ?? 0);
    info.paired_advertiser = adv ? `${adv.name || adv.advertiser_id}` : null;
    info.excluded = usedUploads.has(u.id)
      ? null
      : "有广告户接口取不到，且该分卷金额对不上任何已抓取成功的户 → 不参与本次对账";
  }
  const excludedRows = uRows.filter((r) => !usedUploads.has(r.upload_id));
  uRows.splice(0, uRows.length, ...uRows.filter((r) => usedUploads.has(r.upload_id)));

  type ARow = MatRow & { id: number };
  const aRows = await readAll<ARow>((f, t) =>
    db
      .from("gmv_max_material_agg")
      .select(
        "id, advertiser_id, campaign_id, product_id, item_id, content_type_raw, creative_type, account_name, posted_raw, currency, cost, gross_revenue, orders",
      )
      .eq("batch_id", batchId)
      .order("id")
      .range(f, t),
  );

  // —— 口径对齐（2026-11-25 VN/JP 实测后加，全部在报告 alignment 里显式列出） ——
  // ①接口已不返回 shop_content_type：item_id="-1" 推断为商品卡（VN 6 月 399/399 个商品卡键金额一致），
  //   15–20 位数字推断为视频，其余保持未识别。直播的 item_id 形态未见过，未核验。
  // ②接口有、但拆不到商品/VID 的金额 = campaign 合计 − 明细合计，补一行「无商品ID」残差；
  //   上传表 product_id 非数字（N/A / NULL）的行归到同一类。残差里也含被舍成 0.00 的小额花费。
  const NO_PID = "(无商品ID)";
  let inferredCard = 0,
    inferredVideo = 0;
  for (const r of aRows) {
    if (r.content_type_raw != null && r.creative_type) continue;
    if (r.item_id === "-1") {
      r.creative_type = "product_card";
      inferredCard++;
    } else if (/^\d{15,20}$/.test(r.item_id)) {
      r.creative_type = "video";
      inferredVideo++;
    }
  }
  for (const r of uRows) {
    if (!/^\d+$/.test(r.product_id)) {
      r.creative_type = NO_PID;
      r.product_id = "N/A";
      r.vid = "";
    }
  }
  const residuals: Record<string, unknown>[] = [];
  for (const adv of batch.advertisers) {
    if (adv.status !== "DONE") continue;
    const camp = Object.values(adv.campaign_totals ?? {}).reduce(
      (x, m) => ({
        cost: x.cost + m.cost,
        gross_revenue: x.gross_revenue + m.gross_revenue,
        orders: x.orders + m.orders,
      }),
      { cost: 0, gross_revenue: 0, orders: 0 },
    );
    const det = { cost: 0, gross_revenue: 0, orders: 0 };
    for (const r of aRows)
      if (r.advertiser_id === adv.advertiser_id) {
        det.cost += num(r.cost);
        det.gross_revenue += num(r.gross_revenue);
        det.orders += num(r.orders);
      }
    const res = {
      cost: r2(camp.cost - det.cost),
      gross_revenue: r2(camp.gross_revenue - det.gross_revenue),
      orders: camp.orders - det.orders,
    };
    if (isZero(res)) continue;
    residuals.push({ advertiser: adv.name || adv.advertiser_id, ...res });
    aRows.push({
      id: -1,
      advertiser_id: adv.advertiser_id,
      campaign_id: "",
      product_id: "N/A",
      item_id: "",
      content_type_raw: "(campaign 残差)",
      creative_type: NO_PID,
      account_name: null,
      title: null,
      posted_raw: null,
      currency: null,
      impressions: null,
      clicks: null,
      ...res,
    });
  }

  // —— 合计 ——
  const tot = { api: side(), upload: side() };
  const byType: Record<string, { api: Side; upload: Side }> = {};
  const byCur: Record<string, { api: Side; upload: Side }> = {};
  const typeOf = (t: string) => (byType[t] ??= { api: side(), upload: side() });
  const curOf = (c: string) => (byCur[c || "(空)"] ??= { api: side(), upload: side() });
  for (const r of aRows) {
    const m = { cost: num(r.cost), gross_revenue: num(r.gross_revenue), orders: num(r.orders) };
    addTo(tot.api, m);
    addTo(typeOf(r.creative_type).api, m);
    addTo(curOf(r.currency ?? "").api, m);
  }
  for (const r of uRows) {
    const m = { cost: num(r.cost), gross_revenue: num(r.gross_revenue), orders: num(r.orders) };
    addTo(tot.upload, m);
    addTo(typeOf(r.creative_type).upload, m);
    addTo(curOf(r.currency).upload, m);
  }

  // —— 接口内部一致性：campaign 级合计 vs 素材明细合计（不一致 = 接口明细本身缺数） ——
  const internal: Record<string, unknown>[] = [];
  for (const adv of batch.advertisers) {
    const camp = Object.values(adv.campaign_totals ?? {}).reduce(
      (s, m) => ({
        cost: s.cost + m.cost,
        gross_revenue: s.gross_revenue + m.gross_revenue,
        orders: s.orders + m.orders,
      }),
      { cost: 0, gross_revenue: 0, orders: 0 },
    );
    const det = side();
    for (const r of aRows)
      if (r.advertiser_id === adv.advertiser_id)
        addTo(det, {
          cost: num(r.cost),
          gross_revenue: num(r.gross_revenue),
          orders: num(r.orders),
        });
    internal.push({
      advertiser_id: adv.advertiser_id,
      name: adv.name,
      active: adv.active,
      status: adv.status,
      error: adv.error ?? null,
      campaign_level: {
        cost: r2(camp.cost),
        gross_revenue: r2(camp.gross_revenue),
        orders: camp.orders,
      },
      material_level: round(det),
      zero_rows_skipped: adv.zero_rows ?? 0,
    });
  }

  // —— 键级比较 ——
  const keyOf = (ct: string, vid: string, pid: string) =>
    ct === "video" ? `${ct}|${vid}|${pid}` : `${ct}||${pid}`;
  type K = {
    ct: string;
    vid: string;
    pid: string;
    api: Side;
    upload: Side;
    api_names: Set<string>;
    up_names: Set<string>;
    api_posted: Set<string>;
    up_posted: Set<string>;
  };
  const keys = new Map<string, K>();
  const kOf = (ct: string, vid: string, pid: string) => {
    const k = keyOf(ct, vid, pid);
    let v = keys.get(k);
    if (!v) {
      v = {
        ct,
        vid: ct === "video" ? vid : "",
        pid,
        api: side(),
        upload: side(),
        api_names: new Set(),
        up_names: new Set(),
        api_posted: new Set(),
        up_posted: new Set(),
      };
      keys.set(k, v);
    }
    return v;
  };
  for (const r of aRows) {
    const k = kOf(r.creative_type, r.item_id, r.product_id);
    addTo(k.api, { cost: num(r.cost), gross_revenue: num(r.gross_revenue), orders: num(r.orders) });
    const nm = (r.account_name ?? "").trim();
    if (nm && nm !== "-") k.api_names.add(nm);
    if (r.posted_raw) k.api_posted.add(r.posted_raw);
  }
  for (const r of uRows) {
    const k = kOf(r.creative_type, r.vid, r.product_id);
    addTo(k.upload, {
      cost: num(r.cost),
      gross_revenue: num(r.gross_revenue),
      orders: num(r.orders),
    });
    if (r.account_name) k.up_names.add(r.account_name.trim());
    if (r.posted_at) k.up_posted.add(r.posted_at);
  }
  const onlyApi: Record<string, unknown>[] = [],
    onlyUpload: Record<string, unknown>[] = [],
    amountDiff: Record<string, unknown>[] = [];
  const nameDiff: Record<string, unknown>[] = [],
    postedDiff: Record<string, unknown>[] = [];
  const postedOffsetHist: Record<string, number> = {};
  let matched = 0,
    nameChecked = 0,
    postedChecked = 0;
  const belowPrecision: Record<string, unknown>[] = [];
  const sumBelow = side();
  const sum = {
    only_api: side(),
    only_upload: side(),
    amount_diff_api: side(),
    amount_diff_upload: side(),
  };
  for (const k of keys.values()) {
    const base = { type: k.ct, vid: k.vid, product_id: k.pid };
    if (!k.upload.rows) {
      onlyApi.push({ ...base, ...round(k.api), names: [...k.api_names] });
      addTo(sum.only_api, k.api);
      continue;
    }
    // 接口金额只到 2 位小数，上传表花费有 3 位：花费不足 1 分（< 0.01，可能由多行各 0.00x 组成、分属不同 campaign 时逐行被舍成 0.00）且 GMV、订单为 0 的键，接口里是全 0 行
    if (
      !k.api.rows &&
      k.upload.cost < 0.01 &&
      k.upload.gross_revenue === 0 &&
      k.upload.orders === 0
    ) {
      belowPrecision.push({ ...base, ...round(k.upload) });
      addTo(sumBelow, k.upload);
      continue;
    }
    if (!k.api.rows) {
      onlyUpload.push({ ...base, ...round(k.upload), names: [...k.up_names] });
      addTo(sum.only_upload, k.upload);
      continue;
    }
    matched++;
    if (
      Math.abs(k.api.cost - k.upload.cost) >= 0.01 ||
      Math.abs(k.api.gross_revenue - k.upload.gross_revenue) >= 0.01 ||
      k.api.orders !== k.upload.orders
    ) {
      amountDiff.push({ ...base, api: round(k.api), upload: round(k.upload) });
      addTo(sum.amount_diff_api, k.api);
      addTo(sum.amount_diff_upload, k.upload);
    }
    if (k.ct === "video") {
      if (k.api_names.size || k.up_names.size) {
        nameChecked++;
        const a = [...k.api_names].sort().join(" / "),
          u = [...k.up_names].sort().join(" / ");
        if (a.toLowerCase() !== u.toLowerCase())
          nameDiff.push({ ...base, api: a, upload: u, cost: r2(k.upload.cost) });
      }
      if (k.api_posted.size || k.up_posted.size) {
        postedChecked++;
        const a = [...k.api_posted].sort()[0] ?? "",
          u = [...k.up_posted].sort()[0] ?? "";
        const ta = Date.parse(
          a.includes("T") || /Z|[+-]\d\d:?\d\d$/.test(a) ? a : `${a.replace(" ", "T")}Z`,
        );
        const tu = Date.parse(u);
        const offsetMin =
          Number.isFinite(ta) && Number.isFinite(tu) ? Math.round((ta - tu) / 60000) : null;
        const bucket = offsetMin == null ? "无法解析/一边为空" : `${offsetMin} 分钟`;
        postedOffsetHist[bucket] = (postedOffsetHist[bucket] ?? 0) + 1;
        // 判定口径同现行归因 skill：只比源日历日期（不做时区换算）；分钟时差只作信息
        const dateA = /^\d{4}-\d{2}-\d{2}/.test(a) ? a.slice(0, 10) : "";
        const dateU = Number.isFinite(tu) ? new Date(tu).toISOString().slice(0, 10) : "";
        if (!dateA || dateA !== dateU)
          postedDiff.push({ ...base, api: a, upload: u, offset_min: offsetMin });
      }
    }
  }
  const byAmt = (x: Record<string, unknown>) =>
    Math.abs(num((x as { cost?: number }).cost ?? (x as { upload?: Side }).upload?.cost)) +
    Math.abs(
      num(
        (x as { gross_revenue?: number }).gross_revenue ??
          (x as { upload?: Side }).upload?.gross_revenue,
      ),
    );
  const top = (xs: Record<string, unknown>[], n: number) =>
    xs.sort((a, b) => byAmt(b) - byAmt(a)).slice(0, n);
  const ok = (a: Side, u: Side) =>
    Math.abs(a.cost - u.cost) < 0.01 &&
    Math.abs(a.gross_revenue - u.gross_revenue) < 0.01 &&
    a.orders === u.orders;

  const fields = batch.fields ?? {};
  const warnings = [...(fields.warnings ?? [])];
  if (inferredCard + inferredVideo)
    warnings.push(
      `接口未返回内容类型，已按 item_id 推断：商品卡 ${inferredCard} 行（item_id=-1）、视频 ${inferredVideo} 行（推断值，不是接口原值；直播形态未核验）`,
    );
  for (const ct of Object.keys(fields.content_types ?? {})) {
    if (ct === "(null)" && inferredCard + inferredVideo) continue;
    if (!["video", "product_card", "live"].includes(normContentType(ct === "(null)" ? "" : ct)))
      warnings.push(
        `接口返回未识别的内容类型「${ct}」（${fields.content_types![ct]} 行），未归入视频/商品卡/直播`,
      );
  }
  for (const m of MONEY_METRICS)
    if (fields.money_metrics_seen && !fields.money_metrics_seen.includes(m))
      warnings.push(`接口没有返回 metric「${m}」（可能被改名或下线）`);
  if (fields.meta_unavailable)
    warnings.push(`标题/发布时间查询被接口拒绝：${fields.meta_unavailable}`);
  if (!fields.posted_field)
    warnings.push(`发布时间：候选字段 ${POSTED_CANDIDATES.join(" / ")} 都没有返回值`);
  if (batch.advertisers.some((a) => a.status === "FAILED"))
    warnings.push(
      `有广告户抓取失败：${batch.advertisers
        .filter((a) => a.status === "FAILED")
        .map((a) => `${a.name || a.advertiser_id}：${a.error}`)
        .join("；")}`,
    );

  const report = {
    generated_at: new Date().toISOString(),
    pass: {
      // 没有可比的数据不算通过（上轮错误：两边一边为 0 行时达人名/发布时间显示 ✓）
      totals: tot.api.rows > 0 && ok(tot.api, tot.upload),
      key_sets: matched > 0 && !onlyApi.length && !onlyUpload.length,
      amounts_per_key: matched > 0 && !amountDiff.length,
      account_names: nameChecked > 0 && !nameDiff.length,
      posted_at: postedChecked > 0 && !postedDiff.length,
      no_warnings: !warnings.length,
    },
    totals: { api: round(tot.api), upload: round(tot.upload) },
    alignment: {
      inferred_content_type: { product_card: inferredCard, video: inferredVideo },
      campaign_residuals: residuals,
      below_api_precision: {
        count: belowPrecision.length,
        ...round(sumBelow),
        samples: belowPrecision.slice(0, 50),
      },
    },
    by_type: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, { api: round(v.api), upload: round(v.upload) }]),
    ),
    by_currency: Object.fromEntries(
      Object.entries(byCur).map(([k, v]) => [k, { api: round(v.api), upload: round(v.upload) }]),
    ),
    uploads: uploadInfo,
    excluded_upload_totals: (() => {
      const t = side();
      for (const r of excludedRows)
        addTo(t, { cost: num(r.cost), gross_revenue: num(r.gross_revenue), orders: num(r.orders) });
      return round(t);
    })(),
    api_internal: internal,
    keys: {
      total: keys.size,
      matched,
      only_api: { count: onlyApi.length, ...round(sum.only_api), top: top(onlyApi, 500) },
      only_upload: {
        count: onlyUpload.length,
        ...round(sum.only_upload),
        top: top(onlyUpload, 500),
      },
      amount_diff: {
        count: amountDiff.length,
        api: round(sum.amount_diff_api),
        upload: round(sum.amount_diff_upload),
        top: top(amountDiff, 500),
      },
    },
    account_names: { checked: nameChecked, diff: nameDiff.length, samples: top(nameDiff, 200) },
    posted_at: {
      field: fields.posted_field ?? null,
      checked: postedChecked,
      diff: postedDiff.length,
      offset_hist: postedOffsetHist,
      samples: postedDiff.slice(0, 200),
    },
    warnings,
  };
  const { error } = await db
    .from("gmv_max_material_batches")
    .update({ report, reconciled_at: new Date().toISOString() })
    .eq("id", batchId);
  if (error) throw new Error(error.message);
  return report;
}

export async function listBatches(db: SupabaseClient, limit = 20) {
  const { data, error } = await db
    .from("gmv_max_material_batches")
    .select(
      "id, country, month, status, triggered_by, started_at, finished_at, reconciled_at, error, report->pass, report->totals",
    )
    .or("triggered_by.is.null,triggered_by.not.like.probe:*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getBatch(db: SupabaseClient, id: string) {
  const { data, error } = await db
    .from("gmv_max_material_batches")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("批次不存在");
  return data;
}

// ───────────────────────── 一次性：发布时间来源探测 ─────────────────────────
// GMV MAX 报表接口没有发布时间字段（2026-11-25 实测 Invalid metric）。这里对同一批 VID
// 同时试三个候选接口，原始返回存进一个探测批次（triggered_by='probe:posted'），供对账文档取证。
// 候选：①TikTok Shop Analytics 单视频表现 ②TikTok Shop Analytics 视频列表 ③Business API /gmv_max/video/get/
export async function probePostedTime(
  db: SupabaseClient,
  country: string,
  passcode: string,
  adminName: string,
) {
  const { data: advs, error } = await db
    .from("advertiser_countries")
    .select("advertiser_id, shop_id")
    .eq("country", country);
  if (error) throw new Error(error.message);
  const shopId = String(advs?.[0]?.shop_id ?? "");
  if (!shopId) throw new Error(`站点 ${country} 没有店铺 ID`);
  // 样本 VID：该站点最近一个月上传表里花费最高、带发布时间的 5 个视频 + 已知的定时发布样本
  const { data: ups } = await db
    .from("ad_uploads")
    .select("id, month")
    .eq("country", country)
    .eq("status", "READY")
    .order("month", { ascending: false })
    .limit(2);
  const sample: { vid: string; upload_posted_at: string | null; upload_account?: string }[] = [];
  if (ups?.length) {
    const { data: rows } = await db
      .from("ad_upload_agg")
      .select("vid, posted_at, cost, account_name")
      .in(
        "upload_id",
        ups.map((u) => u.id),
      )
      .neq("vid", "")
      .not("posted_at", "is", null)
      .order("cost", { ascending: false })
      .limit(5);
    for (const r of rows ?? [])
      sample.push({
        vid: String(r.vid),
        upload_posted_at: r.posted_at as string,
        upload_account: String(r.account_name ?? ""),
      });
  }
  if (country === "VN")
    sample.push({ vid: "7559874631184911623", upload_posted_at: "2025-10-12T13:00:00+00:00" });

  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const raw = async (path: string, query: Record<string, string>) => {
    const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/tts-p0-probe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "x-admin-passcode": passcode,
        "x-admin-name": adminName,
      },
      body: JSON.stringify({ action: "raw", shop_id: shopId, method: "GET", path, query }),
    });
    const text = await r.text();
    return { http: r.status, body: text.slice(0, 6000) };
  };
  const today = new Date().toISOString().slice(0, 10);
  // 分析接口日期区间最长 60 天（未核验）：取样本所在月 1 日起 59 天
  const winStart = ups?.length ? `${ups[0].month}-01` : today;
  const winEndD = new Date(Date.parse(`${winStart}T00:00:00Z`) + 59 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const yearAgo = winStart;
  const winEnd = winEndD < today ? winEndD : today;
  const out: Record<string, unknown> = {
    country,
    shop_id: shopId,
    sample,
    at: new Date().toISOString(),
  };

  // ① 单视频表现
  const detail: Record<string, unknown> = {};
  for (const s of sample.slice(0, 3).concat(sample.slice(5))) {
    detail[s.vid] = await raw(`/analytics/202509/shop_videos/${s.vid}/performance`, {
      start_date_ge: yearAgo,
      end_date_lt: winEnd,
      granularity: "ALL",
      currency: "LOCAL",
    });
  }
  out.shop_video_detail = detail;
  // ② 视频列表（两个版本号都试）
  out.shop_video_list = {
    v202605: await raw("/analytics/202605/shop_videos/performance", {
      start_date_ge: yearAgo,
      end_date_lt: winEnd,
      page_size: "5",
      currency: "LOCAL",
    }),
    v202409: await raw("/analytics/202409/shop_videos/performance", {
      start_date_ge: yearAgo,
      end_date_lt: winEnd,
      page_size: "5",
      currency: "LOCAL",
    }),
  };
  // ④ 批量视频表现（2026-09 新版，资料称含 video.video_post_time / video.username，一次 ≤500 个 VID，未核验）
  //    video_ids 传法未知：JSON 数组与逗号分隔各试一次
  const vids = sample.map((x) => x.vid);
  out.shop_video_batch = {
    json_array: await raw("/analytics/202609/shop_videos/batch_performance", {
      video_ids: JSON.stringify(vids),
      start_date_ge: winStart,
      end_date_lt: winEnd,
      currency: "LOCAL",
    }),
    comma: await raw("/analytics/202609/shop_videos/batch_performance", {
      video_ids: vids.join(","),
      start_date_ge: winStart,
      end_date_lt: winEnd,
      currency: "LOCAL",
    }),
  };
  // ③ Business API GMV Max 可投视频（需 store_authorized_bc_id；用连接的 bc_id）
  const gm: Record<string, unknown> = {};
  for (const a of (advs ?? []).slice(0, 3)) {
    const { data: conns } = await db
      .from("tiktok_connections")
      .select("access_token, bc_id")
      .contains("advertiser_ids", [String(a.advertiser_id)]);
    for (const c of (conns ?? []) as { access_token: string; bc_id: string | null }[]) {
      if (!c.bc_id) continue;
      try {
        const d = await ttGet(c.access_token, "/gmv_max/video/get/", {
          advertiser_id: String(a.advertiser_id),
          store_id: shopId,
          store_authorized_bc_id: c.bc_id,
          page: "1",
          page_size: "5",
        });
        gm[`${a.advertiser_id}@${c.bc_id}`] = JSON.stringify(d).slice(0, 6000);
        break;
      } catch (e) {
        gm[`${a.advertiser_id}@${c.bc_id}`] = `ERROR ${(e as Error).message}`;
      }
    }
  }
  out.gmv_max_video_get = gm;

  const { data: b, error: e2 } = await db
    .from("gmv_max_material_batches")
    .insert({
      country,
      month: today.slice(0, 7),
      status: "READY",
      triggered_by: "probe:posted",
      fields: { probe: out },
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2) throw new Error(e2.message);
  return { probe_batch_id: b.id, ...out };
}

// ───────────────────────── 一次性：batch_performance 覆盖面探测 ─────────────────────────
// 2026-11-25 实测 /analytics/202609/shop_videos/batch_performance 可用（video_ids 逗号分隔），返回
// video.username（达人 handle）与 video.video_post_time（站点当地时间）。这里拿某站点某月上传表里
// 全部有花费的 VID 去查，只存解析后的字段，回答：覆盖率、定时发布视频的发布时间是否与导出一致、username 能否对上登记。
export async function probeBatchPerformance(
  db: SupabaseClient,
  country: string,
  month: string,
  passcode: string,
  adminName: string,
) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
  const { data: advs } = await db
    .from("advertiser_countries")
    .select("shop_id")
    .eq("country", country)
    .limit(1);
  const shopId = String(advs?.[0]?.shop_id ?? "");
  if (!shopId) throw new Error(`站点 ${country} 没有店铺 ID`);
  const { data: ups, error } = await db
    .from("ad_uploads")
    .select("id, file_name")
    .eq("country", country)
    .eq("month", month)
    .eq("status", "READY");
  if (error) throw new Error(error.message);
  if (!ups?.length) throw new Error(`${country} ${month} 没有已上传的表`);
  type U = {
    upload_id: string;
    vid: string;
    account_name: string;
    posted_at: string | null;
    cost: number;
  };
  const byVid = new Map<
    string,
    { file: string; names: Set<string>; posted: string | null; cost: number }
  >();
  for (const u of ups) {
    const rows = await readAll<U>((f, t) =>
      db
        .from("ad_upload_agg")
        .select("upload_id, vid, account_name, posted_at, cost")
        .eq("upload_id", u.id)
        .neq("vid", "")
        .gt("cost", 0)
        .order("id")
        .range(f, t),
    );
    for (const r of rows) {
      const v = byVid.get(r.vid) ?? {
        file: u.file_name,
        names: new Set<string>(),
        posted: r.posted_at,
        cost: 0,
      };
      if (r.account_name) v.names.add(r.account_name);
      if (r.posted_at && (!v.posted || r.posted_at < v.posted)) v.posted = r.posted_at;
      v.cost += num(r.cost);
      byVid.set(r.vid, v);
    }
  }
  // 大站一个月可能上万个 VID：按花费取前 3000 个（≤15 次调用），覆盖到的花费比例写进 summary
  const allVids = [...byVid.keys()].sort((x, y) => byVid.get(y)!.cost - byVid.get(x)!.cost);
  const vids = allVids.slice(0, 3000);
  const winStart = `${month}-01`;
  const today = new Date().toISOString().slice(0, 10);
  const e = new Date(Date.parse(`${winStart}T00:00:00Z`) + 59 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const winEnd = e < today ? e : today;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const got = new Map<string, { username: string | null; post: string | null }>();
  const errors: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < vids.length; i += BATCH) {
    const chunkVids = vids.slice(i, i + BATCH);
    const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/tts-p0-probe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "x-admin-passcode": passcode,
        "x-admin-name": adminName,
      },
      body: JSON.stringify({
        action: "raw",
        shop_id: shopId,
        method: "GET",
        path: "/analytics/202609/shop_videos/batch_performance",
        query: {
          video_ids: chunkVids.join(","),
          start_date_ge: winStart,
          end_date_lt: winEnd,
          currency: "LOCAL",
        },
      }),
    });
    const j = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      error?: string;
      data?: { videos?: { video_id?: string; video?: Record<string, unknown> }[] };
    };
    if (!r.ok || j.ok === false || j.error) {
      errors.push(`第 ${i / BATCH + 1} 批：HTTP ${r.status} ${j.error ?? j.message ?? ""}`);
      continue;
    }
    for (const v of j.data?.videos ?? []) {
      const id = String(v.video_id ?? v.video?.id ?? "");
      if (!id) continue;
      got.set(id, {
        username: v.video?.username == null ? null : String(v.video.username),
        post: v.video?.video_post_time == null ? null : String(v.video.video_post_time),
      });
    }
  }
  const rows = vids.map((vid) => {
    const u = byVid.get(vid)!;
    const g = got.get(vid);
    return {
      vid,
      file: u.file,
      cost: r2(u.cost),
      names: [...u.names].join(" / "),
      upload_posted: u.posted,
      returned: !!g,
      username: g?.username ?? null,
      api_post: g?.post ?? null,
    };
  });
  const summary = {
    country,
    month,
    window: [winStart, winEnd],
    requested: vids.length,
    vids_total: allVids.length,
    cost_all_vids: r2(allVids.reduce((x, v) => x + byVid.get(v)!.cost, 0)),
    returned: got.size,
    cost_total: r2(rows.reduce((x, r) => x + r.cost, 0)),
    cost_returned: r2(rows.filter((r) => r.returned).reduce((x, r) => x + r.cost, 0)),
    errors,
  };
  const { data: b, error: e2 } = await db
    .from("gmv_max_material_batches")
    .insert({
      country,
      month,
      status: "READY",
      triggered_by: "probe:batch_performance",
      fields: { probe_batch: { summary, rows } },
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2) throw new Error(e2.message);
  return { probe_batch_id: b.id, ...summary };
}

// ───────────────────────── 一次性：GMV Max 报表素材字段探测（1127.331） ─────────────────────────
// 背景：素材抓取用维度 [campaign_id, item_group_id, item_id] 时，tt_account_name / shop_content_type /
// tt_account_authorization_type / title 被接口判为 Invalid metric；旧同步第 3 阶段用维度 [item_id]
// + 过滤 campaign_ids & item_group_ids 时能取到。这里对同一个广告户/系列/商品，按 3 种维度组合各请求一次，
// 并对 [item_id] 逐个字段单独请求，原始返回（前 3 行）与报错原文存库，供 Claude 读取。只读，不写业务表。
export async function probeCreativeFields(db: SupabaseClient, country: string) {
  const { data: advs, error } = await db
    .from("advertiser_countries")
    .select("advertiser_id, shop_id, advertiser_name")
    .eq("country", country);
  if (error) throw new Error(error.message);
  const end = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86400_000).toISOString().slice(0, 10);
  const EXTRA = [
    "tt_account_name", "tt_account_profile_image_url", "tt_account_authorization_type",
    "shop_content_type", "title", "identity_id", "product_name",
  ];
  const BASE = ["cost", "orders", "gross_revenue"];
  const out: Record<string, unknown> = { country, window: [start, end], at: new Date().toISOString() };
  const call = async (token: string, adv: string, shop: string, dims: string[], filter: Record<string, unknown>, metrics: string[]) => {
    try {
      const d = await ttGet(token, "/gmv_max/report/get/", {
        advertiser_id: adv, store_ids: JSON.stringify([shop]), dimensions: JSON.stringify(dims),
        metrics: JSON.stringify(metrics), start_date: start, end_date: end, page: "1", page_size: "20",
        filtering: JSON.stringify(filter),
      });
      const list = (d.list ?? []) as Record<string, unknown>[];
      return { ok: true, rows: list.length, sample: list.slice(0, 3) };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }
  };
  let picked: Record<string, string> | null = null;
  const pickErrors: string[] = [];
  out.pick_errors = pickErrors;
  for (const a of (advs ?? []) as { advertiser_id: string; shop_id: string | null; advertiser_name: string | null }[]) {
    const shop = String(a.shop_id ?? "");
    if (!shop) continue;
    const { data: conns } = await db
      .from("tiktok_connections")
      .select("access_token")
      .contains("advertiser_ids", [String(a.advertiser_id)]);
    for (const c of (conns ?? []) as { access_token: string }[]) {
      try {
        const d = await ttGet(c.access_token, "/gmv_max/report/get/", {
          advertiser_id: String(a.advertiser_id), store_ids: JSON.stringify([shop]),
          dimensions: JSON.stringify(["campaign_id", "item_group_id"]), metrics: JSON.stringify(["cost"]),
          start_date: start, end_date: end, page: "1", page_size: "50", filtering: "{}",
          sort_field: "cost", sort_type: "DESC",
        });
        const top = ((d.list ?? []) as Record<string, unknown>[])
          .map((r) => ({ dims: (r.dimensions ?? {}) as Record<string, unknown>, cost: Number(((r.metrics ?? {}) as Record<string, unknown>).cost ?? 0) }))
          .filter((r) => r.cost > 0 && r.dims.item_group_id && r.dims.campaign_id)
          .sort((x, y) => y.cost - x.cost)[0];
        if (top) {
          picked = { token: c.access_token, adv: String(a.advertiser_id), name: String(a.advertiser_name ?? ""), shop,
            cid: String(top.dims.campaign_id), igid: String(top.dims.item_group_id) };
          break;
        }
      } catch (e) {
        pickErrors.push(`${a.advertiser_id}: ${(e as Error).message.slice(0, 300)}`);
      }
    }
    if (picked) break;
  }
  if (!picked) throw new Error(`站点 ${country} 近 7 天没找到有花费的广告户/系列/商品`);
  const { token, adv, shop, cid, igid } = picked;
  out.picked = { advertiser_id: adv, advertiser_name: picked.name, campaign_id: cid, item_group_id: igid };
  const f = { campaign_ids: [cid], item_group_ids: [igid] };
  out.variants = {
    item_id_only: await call(token, adv, shop, ["item_id"], f, [...BASE, ...EXTRA]),
    item_id_day: await call(token, adv, shop, ["item_id", "stat_time_day"], f, [...BASE, ...EXTRA]),
    cid_igid_item: await call(token, adv, shop, ["campaign_id", "item_group_id", "item_id"], f, [...BASE, ...EXTRA]),
  };
  const single: Record<string, unknown> = {};
  for (const m of EXTRA) single[m] = await call(token, adv, shop, ["item_id"], f, [...BASE, m]);
  out.single_item_id = single;
  const { data: b, error: e2 } = await db
    .from("gmv_max_material_batches")
    .insert({
      country, month: end.slice(0, 7), status: "READY", triggered_by: "probe:creative",
      fields: { probe_creative: out }, finished_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2) throw new Error(e2.message);
  return { probe_batch_id: b.id, picked: out.picked };
}
