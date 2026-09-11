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

/**
 * 用户视图 KPI 阈值：同事×站点归因 GMV 低于该值不展示、不计入 KPI。
 * 0 = 关闭阈值，全部格子都计入（2026-09-09 按项目负责人要求暂时关闭，前端在阈值 <=0 时不显示相关提示）。
 */
export const KPI_MIN_SITE_USD = 0;

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
    // 全表拉取 MANUAL 别名（人工判定表通常很小）比按 alias_norm 分块 .in() 更稳：
    // 大文件推断出的别名可能上千个、含中日文/emoji 昵称，chunked GET 请求的 URL 会被撑到超长导致网络层报错。
    const manualRows = await pageAll<{ alias_norm: string; country: string }>((f, t) =>
      db.from("creator_alias").select("alias_norm, country").eq("source", "MANUAL").range(f, t),
    );
    const manualNorms = new Set(manualRows.map((r) => identityKey(r.country, r.alias_norm)));
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

/** vids / creators = 该格子里去重后的归因 VID 数与归因达人昵称数，和 GMV 并列展示。 */
export type StaffCell = {
  country: string;
  gmv: number;
  cost: number;
  orders: number;
  vids: number;
  creators: number;
  counted: boolean;
};
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
  /** 全站点合计的去重计数 */
  vids: number;
  creators: number;
};
export type BucketAgg = { gmv: number; cost: number; orders: number; rows: number; vids?: number; creators?: number };
export type AttributionReport = {
  period: { start: string; end: string };
  month?: string;
  kpi_threshold: number;
  staff: StaffAgg[];
  product_card: BucketAgg;
  unmatched: BucketAgg & { top: Array<{ account_name: string; gmv: number; rows: number }> };
  /**
   * 每个非美元币种一行。`usd_rate` 为 null = 缺汇率、这些行未计入任何汇总；
   * 有值 = 已按 本币/usd_rate 折美元并计入，`gmv_usd` 是折算后的金额，供人工核对量级。
   */
  non_usd: Array<{ currency: string; gmv: number; cost: number; rows: number; usd_rate: number | null; gmv_usd: number }>;
  totals: { gmv: number; cost: number; orders: number; rows: number; vids: number; creators: number };
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

/** 找出一批输入行里出现的、但 exchangeRates 未配置的币种（USD 恒有效）。 */
export function findMissingCurrencies(
  inputs: Array<{ currency: string }>,
  exchangeRates: ExchangeRateMap,
): string[] {
  const missing = new Set<string>();
  for (const input of inputs) {
    const cur = (input.currency || "USD").toUpperCase();
    if (!exchangeRates.get(cur)) missing.add(cur);
  }
  return Array.from(missing).sort();
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
  const nonUsd = new Map<string, { currency: string; gmv: number; cost: number; rows: number; usd_rate: number | null; gmv_usd: number }>();
  const totals = { gmv: 0, cost: 0, orders: 0, rows: 0, vids: 0, creators: 0 };

  for (const { input, result } of pairs) {
    const cur = (input.currency || "USD").toUpperCase();
    const rate = opts.exchangeRates?.get(cur) ?? (cur === "USD" ? 1 : 0);
    if (!rate) {
      const e = nonUsd.get(cur) ?? { currency: cur, gmv: 0, cost: 0, rows: 0, usd_rate: null, gmv_usd: 0 };
      e.gmv += input.grossRevenue;
      e.cost += input.cost;
      e.rows++;
      nonUsd.set(cur, e);
      continue;
    }
    // usd_rate 语义：1 美元 = 多少本币（如 THB 填 33）。折美元 = 本币金额 / 汇率。
    const gmvUsd = input.grossRevenue / rate;
    const costUsd = input.cost / rate;
    if (cur !== "USD") {
      const e = nonUsd.get(cur) ?? { currency: cur, gmv: 0, cost: 0, rows: 0, usd_rate: rate, gmv_usd: 0 };
      e.gmv += input.grossRevenue;
      e.cost += input.cost;
      e.gmv_usd += gmvUsd;
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
        vids: 0,
        creators: 0,
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
      cell = { country, gmv: 0, cost: 0, orders: 0, vids: 0, creators: 0, counted: false };
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
      cell.counted = KPI_MIN_SITE_USD <= 0 || cell.gmv >= KPI_MIN_SITE_USD;
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
  const top = Array.from(unmatchedTop.values()).sort((a, b) => b.gmv - a.gmv);


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

/**
 * 数据库 RPC `attribution_apply_run` 返回的紧凑汇总行。
 * 一行 = 一个 (桶, 同事, 角色, 匹配方式, 站点, 币种, 是否有汇率) 组合，整月最多几百行。
 */
export type CompactRow = {
  bucket: string;
  staff: string | null;
  role: string | null;
  match_type: string | null;
  country: string;
  currency: string;
  has_rate: boolean;
  gmv_native: number;
  cost_native: number;
  gmv_usd: number;
  cost_usd: number;
  orders: number;
  rows_count: number;
  /** 恒为 0：去重计数改由 attribution_run_distinct 按「只按同事+国家」的口径单独给 */
  vids: number;
  creators: number;
};

/** attribution_run_distinct 的一行。scope = CELL(同事×国家) / STAFF(同事) / TOTAL(整月)。 */
export type DistinctRow = {
  scope: "CELL" | "STAFF" | "TOTAL";
  staff: string | null;
  role: string | null;
  country: string | null;
  vids: number;
  creators: number;
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * 用数据库算好的紧凑汇总拼出报表 JSON。
 * 几十万行的求和与去重计数都在数据库里完成，这里只做「几百行 → 报表结构」的整形，
 * 所以整月多大都跑得动。
 *
 * 注意去重计数不能跨格子相加（同一个 VID 可能出现在多个币种/匹配方式的格子里），
 * 所以同事合计、站点格子、总计三层各自取数据库给的对应粒度：这里对同一站点内的多个
 * (币种×匹配方式) 行取 max 作为该格子的去重数，同事合计与总计由调用方另传。
 */
export function buildReportFromCompact(
  rows: CompactRow[],
  opts: {
    period: { start: string; end: string };
    month?: string;
    targets?: TargetMap;
    staffMeta?: StaffMeta;
    exchangeRates?: ExchangeRateMap;
    unmatchedTop?: Array<{ account_name: string; gmv: number; rows: number }>;
    /** 数据库按「只按同事+国家」口径算出的精确去重数（CELL / STAFF / TOTAL 三个粒度） */
    distinct?: DistinctRow[];
  },
): AttributionReport {
  const staffMap = new Map<string, StaffAgg>();
  const cellMap = new Map<string, StaffCell>();
  // 去重数一律用数据库按 (同事, 国家) 算好的精确值，绝不在这里相加或取最大值估算
  const cellDistinct = new Map<string, { vids: number; creators: number }>();
  const staffDistinct = new Map<string, { vids: number; creators: number }>();
  let totalDistinct = { vids: 0, creators: 0 };
  for (const d of opts.distinct ?? []) {
    const role = d.role === "EDITOR" ? "EDITOR" : "BD";
    if (d.scope === "TOTAL") {
      totalDistinct = { vids: n(d.vids), creators: n(d.creators) };
    } else if (d.scope === "STAFF" && d.staff) {
      staffDistinct.set(`${d.staff}|${role}`, { vids: n(d.vids), creators: n(d.creators) });
    } else if (d.scope === "CELL" && d.staff) {
      cellDistinct.set(`${d.staff}|${role}|${d.country || "未知站点"}`, { vids: n(d.vids), creators: n(d.creators) });
    }
  }
  const productCard: BucketAgg = { gmv: 0, cost: 0, orders: 0, rows: 0, vids: 0, creators: 0 };
  const unmatched: BucketAgg = { gmv: 0, cost: 0, orders: 0, rows: 0, vids: 0, creators: 0 };
  const nonUsd = new Map<string, { currency: string; gmv: number; cost: number; rows: number; usd_rate: number | null; gmv_usd: number }>();
  const totals = { gmv: 0, cost: 0, orders: 0, rows: 0, vids: 0, creators: 0 };

  for (const r of rows) {
    const cur = (r.currency || "USD").toUpperCase();
    const gmvUsd = n(r.gmv_usd);
    const costUsd = n(r.cost_usd);
    const rowsCount = n(r.rows_count);

    // 归并时就已折美元；这里只为「非美元币种」留一份原币种对照，缺汇率的单独标出来
    if (cur !== "USD" || !r.has_rate) {
      const e = nonUsd.get(cur) ?? {
        currency: cur,
        gmv: 0,
        cost: 0,
        rows: 0,
        usd_rate: r.has_rate ? (opts.exchangeRates?.get(cur) ?? null) : null,
        gmv_usd: 0,
      };
      e.gmv += n(r.gmv_native);
      e.cost += n(r.cost_native);
      e.rows += rowsCount;
      e.gmv_usd += gmvUsd;
      nonUsd.set(cur, e);
    }
    // 缺汇率的行折不出美元，不进任何美元口径的汇总（上面的 non_usd 里已单列出来提示）
    if (!r.has_rate) continue;

    totals.gmv += gmvUsd;
    totals.cost += costUsd;
    totals.orders += n(r.orders);
    totals.rows += rowsCount;

    if (r.bucket === "PRODUCT_CARD") {
      productCard.gmv += gmvUsd;
      productCard.cost += costUsd;
      productCard.orders += n(r.orders);
      productCard.rows += rowsCount;
      productCard.vids = Math.max(productCard.vids ?? 0, n(r.vids));
      productCard.creators = Math.max(productCard.creators ?? 0, n(r.creators));
      continue;
    }
    if (r.bucket !== "STAFF" || !r.staff) {
      unmatched.gmv += gmvUsd;
      unmatched.cost += costUsd;
      unmatched.orders += n(r.orders);
      unmatched.rows += rowsCount;
      unmatched.vids = Math.max(unmatched.vids ?? 0, n(r.vids));
      unmatched.creators = Math.max(unmatched.creators ?? 0, n(r.creators));
      continue;
    }

    const role = (r.role === "EDITOR" ? "EDITOR" : "BD") as Role;
    const sKey = `${r.staff}|${role}`;
    let agg = staffMap.get(sKey);
    if (!agg) {
      agg = {
        staff_name: r.staff,
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
        vids: 0,
        creators: 0,
      };
      staffMap.set(sKey, agg);
    }
    agg.gmv += gmvUsd;
    agg.cost += costUsd;
    agg.orders += n(r.orders);
    if (r.match_type) {
      const mt = r.match_type as MatchType;
      agg.by_match[mt] = (agg.by_match[mt] ?? 0) + gmvUsd;
    }

    const country = r.country || "未知站点";
    const cKey = `${sKey}|${country}`;
    let cell = cellMap.get(cKey);
    if (!cell) {
      cell = { country, gmv: 0, cost: 0, orders: 0, vids: 0, creators: 0, counted: false };
      cellMap.set(cKey, cell);
      agg.by_country.push(cell);
    }
    cell.gmv += gmvUsd;
    cell.cost += costUsd;
    cell.orders += n(r.orders);
  }

  for (const [cKey, cell] of cellMap) {
    const cd = cellDistinct.get(cKey);
    cell.vids = cd?.vids ?? 0;
    cell.creators = cd?.creators ?? 0;
  }

  for (const [sKey, agg] of staffMap) {
    for (const cell of agg.by_country) {
      cell.counted = KPI_MIN_SITE_USD <= 0 || cell.gmv >= KPI_MIN_SITE_USD;
      if (cell.counted) agg.counted_gmv += cell.gmv;
    }
    agg.by_country.sort((a, b) => b.gmv - a.gmv);
    // 同事合计：用数据库按同事粒度单独去重的结果（不是把各站点格子相加）
    const sd = staffDistinct.get(sKey);
    agg.vids = sd?.vids ?? 0;
    agg.creators = sd?.creators ?? 0;
    const meta = opts.staffMeta?.get(sKey);
    agg.active = meta?.active ?? false;
    const target = opts.targets?.get(sKey);
    if (target != null && target > 0) {
      agg.target_usd = target;
      agg.progress = agg.counted_gmv / target;
    } else if (target != null) {
      agg.target_usd = target;
    }
  }

  totals.vids = totalDistinct.vids;
  totals.creators = totalDistinct.creators;

  return {
    period: opts.period,
    month: opts.month,
    kpi_threshold: KPI_MIN_SITE_USD,
    staff: Array.from(staffMap.values()).sort((a, b) => b.gmv - a.gmv),
    product_card: productCard,
    unmatched: { ...unmatched, top: opts.unmatchedTop ?? [] },
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
