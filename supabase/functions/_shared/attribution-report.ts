// 归因报表模块：上下文加载 / 引擎产物落库 / 汇总聚合 / 月度报表构建。
// attribution-run 与 attribution-feishu(write-progress)、attribution-upload(finalize/get) 共用，
// 避免 Edge Function 之间 HTTP 互调。
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  type AttrContext,
  type AttrInputRow,
  type AttrRowResult,
  type AttrRunResult,
  type Handover,
  type MatchType,
  type NewAlias,
  type ReviewItem,
  type Role,
  type VidRegistration,
  attributeRows,
  identityKey,
  normalizeCreativeType,
  normalizeName,
  vidToPostedAt,
} from "./attribution.ts";

/** 用户视图 KPI 阈值：同事×站点归因 GMV 低于该值不展示、不计入 KPI。 */
export const KPI_MIN_SITE_USD = 2000;

// ---------- 分页工具 ----------

const PAGE = 1000;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ---------- 上下文加载 ----------

export type StaffMeta = Map<string, { role: Role; active: boolean }>; // key: `${name}|${role}`

export async function loadStaffMeta(db: SupabaseClient): Promise<StaffMeta> {
  const rows = await pageAll<{ name: string; role: string; active: boolean }>((f, t) =>
    db.from("staff_sheets").select("name, role, active").range(f, t),
  );
  const m: StaffMeta = new Map();
  for (const r of rows) m.set(`${r.name}|${r.role}`, { role: r.role as Role, active: !!r.active });
  return m;
}

export async function loadAttrContext(db: SupabaseClient): Promise<AttrContext> {
  // 1) VID 登记：staff_vid_map（无日期）∪ creator_registry（含日期与归档）
  const vidRegs = new Map<string, VidRegistration[]>();
  const addReg = (vid: string, reg: VidRegistration) => {
    if (!vid) return;
    const arr = vidRegs.get(vid) ?? [];
    // 同 (staff, role) 去重，保留日期较新的
    const idx = arr.findIndex((r) => r.staff === reg.staff && r.role === reg.role);
    if (idx >= 0) {
      if ((reg.registerDate ?? "") > (arr[idx].registerDate ?? "")) arr[idx] = reg;
    } else {
      arr.push(reg);
    }
    vidRegs.set(vid, arr);
  };

  const svm = await pageAll<{ country: string; staff_name: string; vid: string; source_type: string }>((f, t) =>
    db.from("staff_vid_map").select("country, staff_name, vid, source_type").range(f, t),
  );
  for (const r of svm) {
    addReg(r.vid, { staff: r.staff_name, role: r.source_type as Role, registerDate: null, country: r.country ?? "" });
  }
  const regRows = await pageAll<{
    vid: string;
    staff_name: string;
    role: string;
    register_date: string | null;
    country: string;
  }>((f, t) =>
    db
      .from("creator_registry")
      .select("vid, staff_name, role, register_date, country")
      .neq("vid", "")
      .range(f, t),
  );
  for (const r of regRows) {
    addReg(r.vid, {
      staff: r.staff_name,
      role: r.role as Role,
      registerDate: r.register_date,
      country: r.country ?? "",
    });
  }

  // 2) 建联表归属：NICKNAME 优先，HANDLE 补缺
  const ownership = new Map<string, { bd: string; keyType: "NICKNAME" | "HANDLE"; country: string }>();
  const ownRows = await pageAll<{ key_type: string; match_key: string; owner_bd: string; country: string }>((f, t) =>
    db.from("creator_ownership").select("key_type, match_key, owner_bd, country").range(f, t),
  );
  for (const r of ownRows) {
    if (r.key_type !== "NICKNAME") continue;
    ownership.set(identityKey(r.country, r.match_key), { bd: r.owner_bd, keyType: "NICKNAME", country: r.country ?? "" });
  }
  for (const r of ownRows) {
    const scoped = identityKey(r.country, r.match_key);
    if (r.key_type !== "HANDLE" || ownership.has(scoped)) continue;
    ownership.set(scoped, { bd: r.owner_bd, keyType: "HANDLE", country: r.country ?? "" });
  }

  // 3) 别名
  const manualAlias = new Map<string, { bd: string; country: string }>();
  const vidAlias = new Map<string, { bd: string; country: string }>();
  const aliasRows = await pageAll<{ alias_norm: string; bd_name: string; country: string; source: string }>((f, t) =>
    db.from("creator_alias").select("alias_norm, bd_name, country, source").range(f, t),
  );
  for (const r of aliasRows) {
    const rec = { bd: r.bd_name, country: r.country ?? "" };
    const scoped = identityKey(r.country, r.alias_norm);
    if (r.source === "MANUAL") manualAlias.set(scoped, rec);
    else vidAlias.set(scoped, rec);
  }

  // 4) 站点交接（按日期升序）
  const handovers = new Map<string, Handover[]>();
  const hRows = await pageAll<{ country: string; from_bd: string; to_bd: string; handover_date: string }>((f, t) =>
    db.from("site_handovers").select("country, from_bd, to_bd, handover_date").range(f, t),
  );
  for (const r of hRows) {
    const arr = handovers.get(r.country) ?? [];
    arr.push({ fromBd: r.from_bd, toBd: r.to_bd, date: r.handover_date });
    handovers.set(r.country, arr);
  }
  for (const arr of handovers.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  // 5) 人工判定（审查表读回）
  const reviewOverrides = new Map<string, string>();
  const rvRows = await pageAll<{ review_key: string; manual_bd: string | null }>((f, t) =>
    db.from("attribution_review").select("review_key, manual_bd").not("manual_bd", "is", null).range(f, t),
  );
  for (const r of rvRows) if (r.manual_bd) reviewOverrides.set(r.review_key, r.manual_bd);

  return { vidRegs, manualAlias, ownership, vidAlias, handovers, reviewOverrides };
}

// ---------- 引擎产物落库 ----------

export async function persistRunArtifacts(db: SupabaseClient, result: AttrRunResult): Promise<{ aliases: number; reviews: number }> {
  let aliases = 0;
  if (result.newAliases.length) {
    // 双保险：MANUAL 行永不被自动覆盖（引擎已跳过，再查一次防并发写入）
    const aliasByKey = new Map<string, NewAlias>();
    for (const a of result.newAliases) {
      aliasByKey.set(`${identityKey(a.country, a.aliasNorm)}\u001fVID_INFERRED`, a);
    }
    const aliasesToPersist = Array.from(aliasByKey.values());
    const norms = Array.from(new Set(aliasesToPersist.map((a) => a.aliasNorm)));
    const manualNorms = new Set<string>();
    for (let i = 0; i < norms.length; i += 500) {
      const { data, error } = await db
        .from("creator_alias")
        .select("alias_norm, country")
        .eq("source", "MANUAL")
        .in("alias_norm", norms.slice(i, i + 500));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { alias_norm: string; country: string }[]) manualNorms.add(identityKey(r.country, r.alias_norm));
    }
    const rows = aliasesToPersist
      .filter((a) => !manualNorms.has(identityKey(a.country, a.aliasNorm)))
      .map((a: NewAlias) => ({
        alias_norm: a.aliasNorm,
        alias_display: a.aliasDisplay,
        bd_name: a.bd,
        country: a.country,
        source: "VID_INFERRED",
        evidence_vids: a.evidenceVids.length,
        evidence: { vids: a.evidenceVids.slice(0, 50) },
      }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("creator_alias").upsert(rows.slice(i, i + 500), { onConflict: "country,alias_norm,source" });
      if (error) throw new Error(error.message);
    }
    aliases = rows.length;
  }

  if (result.reviews.length) {
    const now = new Date().toISOString();
    const reviewByKey = new Map<string, {
      review_key: string;
      review_type: ReviewItem["type"];
      subject: string;
      detail: unknown;
      default_resolution: string;
      last_seen_at: string;
    }>();
    for (const r of result.reviews) {
      reviewByKey.set(r.reviewKey, {
        review_key: r.reviewKey,
        review_type: r.type,
        subject: r.subject,
        detail: r.detail,
        default_resolution: r.defaultResolution,
        last_seen_at: now,
      });
    }
    const rows = Array.from(reviewByKey.values());
    for (let i = 0; i < rows.length; i += 500) {
      // onConflict 只更新 payload 内字段：manual_bd / status / first_seen_at 保持不动
      const { error } = await db.from("attribution_review").upsert(rows.slice(i, i + 500), { onConflict: "review_key" });
      if (error) throw new Error(error.message);
    }
  }
  return { aliases, reviews: result.reviews.length };
}

// ---------- 汇总聚合 ----------

export type StaffCell = { country: string; gmv: number; cost: number; orders: number; counted: boolean };
export type StaffAgg = {
  staff_name: string;
  role: Role;
  active: boolean;
  gmv: number;
  cost: number;
  orders: number;
  counted_gmv: number;
  target_usd: number | null;
  progress: number | null;
  by_match: Partial<Record<MatchType, number>>;
  by_country: StaffCell[];
};
export type BucketAgg = { gmv: number; cost: number; orders: number; rows: number };
export type AttributionReport = {
  period: { start: string; end: string };
  month?: string;
  kpi_threshold: number;
  staff: StaffAgg[];
  product_card: BucketAgg;
  unmatched: BucketAgg & { top: Array<{ account_name: string; gmv: number; rows: number }> };
  non_usd: Array<{ currency: string; gmv: number; cost: number; rows: number }>;
  totals: { gmv: number; cost: number; orders: number; rows: number };
};

export type TargetMap = Map<string, number>; // `${staff}|${role}` ? target_usd
export type ExchangeRateMap = Map<string, number>; // currency ? USD rate

/** Load enabled front-end maintained USD conversion rates for the calculation. */
export async function loadExchangeRates(db: SupabaseClient): Promise<ExchangeRateMap> {
  const rows = await pageAll<{ currency: string; usd_rate: number; enabled: boolean }>((f, t) =>
    db.from("gmv_exchange_rates").select("currency, usd_rate, enabled").eq("enabled", true).range(f, t),
  );
  const rates: ExchangeRateMap = new Map([["USD", 1]]);
  for (const row of rows) {
    const rate = Number(row.usd_rate);
    if (row.currency && Number.isFinite(rate) && rate > 0) rates.set(row.currency.toUpperCase(), rate);
  }
  return rates;
}


export async function loadTargets(db: SupabaseClient, month: string): Promise<TargetMap> {
  const rows = await pageAll<{ staff_name: string; role: string; target_usd: number }>((f, t) =>
    db.from("gmv_targets").select("staff_name, role, target_usd").eq("month", month).range(f, t),
  );
  const m: TargetMap = new Map();
  for (const r of rows) m.set(`${r.staff_name}|${r.role}`, Number(r.target_usd) || 0);
  return m;
}

export function aggregateResults(
  pairs: Array<{ input: AttrInputRow; result: AttrRowResult }>,
  opts: { period: { start: string; end: string }; month?: string; targets?: TargetMap; exchangeRates?: ExchangeRateMap; staffMeta?: StaffMeta },
): AttributionReport {
  const staffMap = new Map<string, StaffAgg>();
  const cellMap = new Map<string, StaffCell>(); // `${staff}|${role}|${country}`
  const productCard: BucketAgg = { gmv: 0, cost: 0, orders: 0, rows: 0 };
  const unmatched: BucketAgg = { gmv: 0, cost: 0, orders: 0, rows: 0 };
  const unmatchedTop = new Map<string, { account_name: string; gmv: number; rows: number }>();
  const nonUsd = new Map<string, { currency: string; gmv: number; cost: number; rows: number }>();
  const totals = { gmv: 0, cost: 0, orders: 0, rows: 0 };

  for (const { input, result } of pairs) {
    const cur = (input.currency || "USD").toUpperCase();
    const rate = opts.exchangeRates?.get(cur) ?? (cur === "USD" ? 1 : 0);
    if (!rate) {
      const e = nonUsd.get(cur) ?? { currency: cur, gmv: 0, cost: 0, rows: 0 };
      e.gmv += input.grossRevenue;
      e.cost += input.cost;
      e.rows++;
      nonUsd.set(cur, e);
      continue;
    }
    const gmvUsd = input.grossRevenue * rate;
    const costUsd = input.cost * rate;
    if (cur !== "USD") {
      const e = nonUsd.get(cur) ?? { currency: cur, gmv: 0, cost: 0, rows: 0 };
      e.gmv += input.grossRevenue;
      e.cost += input.cost;
      e.rows++;
      nonUsd.set(cur, e);
    }
    totals.gmv += gmvUsd;
    totals.cost += costUsd;
    totals.orders += input.orders;
    totals.rows++;

    if (result.bucket === "PRODUCT_CARD") {
      productCard.gmv += gmvUsd;
      productCard.cost += costUsd;
      productCard.orders += input.orders;
      productCard.rows++;
      continue;
    }
    if (result.bucket === "UNMATCHED") {
      unmatched.gmv += gmvUsd;
      unmatched.cost += costUsd;
      unmatched.orders += input.orders;
      unmatched.rows++;
      const norm = normalizeName(input.accountName) || "（无账号）";
      const e = unmatchedTop.get(norm) ?? { account_name: input.accountName.trim() || "（无账号）", gmv: 0, rows: 0 };
      e.gmv += gmvUsd;
      e.rows++;
      unmatchedTop.set(norm, e);
      continue;
    }
    // STAFF
    const staff = result.staff!;
    const role = result.source!;
    const sKey = `${staff}|${role}`;
    let agg = staffMap.get(sKey);
    if (!agg) {
      agg = {
        staff_name: staff,
        role,
        active: false,
        gmv: 0,
        cost: 0,
        orders: 0,
        counted_gmv: 0,
        target_usd: null,
        progress: null,
        by_match: {},
        by_country: [],
      };
      staffMap.set(sKey, agg);
    }
    agg.gmv += gmvUsd;
    agg.cost += costUsd;
    agg.orders += input.orders;
    const mt = result.matchType!;
    agg.by_match[mt] = (agg.by_match[mt] ?? 0) + gmvUsd;

    const country = result.country || "未知站点";
    const cKey = `${sKey}|${country}`;
    let cell = cellMap.get(cKey);
    if (!cell) {
      cell = { country, gmv: 0, cost: 0, orders: 0, counted: false };
      cellMap.set(cKey, cell);
      agg.by_country.push(cell);
    }
    cell.gmv += gmvUsd;
    cell.cost += costUsd;
    cell.orders += input.orders;
  }

  // KPI 阈值：同事×站点 < 阈值的格子不计入 counted_gmv
  for (const agg of staffMap.values()) {
    for (const cell of agg.by_country) {
      cell.counted = cell.gmv >= KPI_MIN_SITE_USD;
      if (cell.counted) agg.counted_gmv += cell.gmv;
    }
    agg.by_country.sort((a, b) => b.gmv - a.gmv);
    const meta = opts.staffMeta?.get(`${agg.staff_name}|${agg.role}`);
    agg.active = meta?.active ?? false;
    const target = opts.targets?.get(`${agg.staff_name}|${agg.role}`);
    if (target != null && target > 0) {
      agg.target_usd = target;
      agg.progress = agg.counted_gmv / target;
    } else if (target != null) {
      agg.target_usd = target;
    }
  }

  const staff = Array.from(staffMap.values()).sort((a, b) => b.gmv - a.gmv);
  const top = Array.from(unmatchedTop.values())
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, 50);

  return {
    period: opts.period,
    month: opts.month,
    kpi_threshold: KPI_MIN_SITE_USD,
    staff,
    product_card: productCard,
    unmatched: { ...unmatched, top },
    non_usd: Array.from(nonUsd.values()).sort((a, b) => b.gmv - a.gmv),
    totals,
  };
}

/** 用户视图：仅在职同事；低于阈值的站点格子整体隐藏；GMV 展示口径 = counted_gmv。 */
export function applyUserView(report: AttributionReport): AttributionReport {
  return {
    ...report,
    staff: report.staff
      .filter((s) => s.active)
      .map((s) => ({
        ...s,
        gmv: s.counted_gmv,
        by_country: s.by_country.filter((c) => c.counted),
        by_match: {},
      }))
      .filter((s) => s.by_country.length > 0),
    product_card: { gmv: 0, cost: 0, orders: 0, rows: 0 },
    unmatched: { gmv: 0, cost: 0, orders: 0, rows: 0, top: [] },
    non_usd: [],
  };
}

// ---------- 月度报表 ----------

export function monthRange(month: string): { start: string; end: string } {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`month 格式应为 YYYY-MM，收到: ${month}`);
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { start, end };
}

export type MonthlyDetailRow = {
  input: AttrInputRow;
  result: AttrRowResult;
  activeDays: number;
};

export type MonthlyRunOutput = {
  report: AttributionReport;
  detail: MonthlyDetailRow[];
  persisted: { aliases: number; reviews: number };
};

/** 月度归因：RPC 分页拉聚合行 → 引擎 → 产物落库 → 汇总。 */
export async function buildMonthlyReport(db: SupabaseClient, month: string): Promise<MonthlyRunOutput> {
  const { start, end } = monthRange(month);

  type RpcRow = {
    vid: string;
    tt_account_name: string;
    shop_content_type: string;
    country: string;
    currency: string;
    posted_at: string | null;
    cost: number;
    gross_revenue: number;
    orders: number;
    active_days: number;
  };
  const rpcRows: RpcRow[] = [];
  {
    const LIMIT = 1000;
    let offset = 0;
    for (;;) {
      const { data, error } = await db.rpc("gmv_attr_monthly_agg", {
        _start: start,
        _end: end,
        _limit: LIMIT,
        _offset: offset,
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as RpcRow[];
      rpcRows.push(...rows);
      if (rows.length < LIMIT) break;
      offset += LIMIT;
    }
  }

  const inputs: AttrInputRow[] = rpcRows.map((r, i) => {
    let postedAt: string | null = null;
    let postedAtSource: AttrInputRow["postedAtSource"] = null;
    if (r.posted_at) {
      postedAt = r.posted_at;
      postedAtSource = "meta";
    } else if (r.vid) {
      const d = vidToPostedAt(r.vid);
      if (d) {
        postedAt = d.toISOString();
        postedAtSource = "vid";
      }
    }
    return {
      key: `m:${i}`,
      creativeType: normalizeCreativeType(r.shop_content_type),
      vid: r.vid ?? "",
      accountName: r.tt_account_name ?? "",
      country: r.country ?? "",
      postedAt,
      postedAtSource,
      currency: r.currency ?? "USD",
      cost: Number(r.cost) || 0,
      grossRevenue: Number(r.gross_revenue) || 0,
      orders: Number(r.orders) || 0,
    };
  });

  const ctx = await loadAttrContext(db);
  const run = attributeRows(inputs, ctx);
  const persisted = await persistRunArtifacts(db, run);

  const resultByKey = new Map(run.rows.map((r) => [r.key, r]));
  const pairs = inputs.map((input) => ({ input, result: resultByKey.get(input.key)! }));

  const [targets, exchangeRates, staffMeta] = await Promise.all([loadTargets(db, month), loadExchangeRates(db), loadStaffMeta(db)]);
  const report = aggregateResults(pairs, { period: { start, end }, month, targets, exchangeRates, staffMeta });

  const detail: MonthlyDetailRow[] = pairs.map((p, i) => ({ ...p, activeDays: rpcRows[i]?.active_days ?? 0 }));
  return { report, detail, persisted };
}
