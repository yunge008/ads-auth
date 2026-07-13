// GMV 归因引擎（纯函数，无 IO）。月度报表(attribution-run)与 Excel 上传(attribution-upload)共用。
//
// 归因瀑布（一行数据全局只归一个人）：
//   1. 商品卡 → PRODUCT_CARD 桶（不归人）
//   2. VID 强匹配（staff_vid_map ∪ 授权记录归档，BD/EDITOR）→ 该同事；双登记冲突进审查表
//   3. 昵称路径（仅 BD）：人工别名 > 建联表归属（保护期解析）> VID 推断别名；再叠加站点交接分段
//   4. 都不中 → UNMATCHED（无建联达人）

export type Role = "BD" | "EDITOR";
export type MatchType = "VID" | "ALIAS_MANUAL" | "REGISTRY" | "ALIAS_VID";
export type Bucket = "STAFF" | "PRODUCT_CARD" | "UNMATCHED";
export type CreativeType = "video" | "product_card" | "live" | "unknown";

// ---------- 归一化 ----------

/** 昵称/用户名归一化：NFKC + trim + 空白折叠 + 小写；'-' / 'N/A' 等占位视为空。 */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (t === "-" || t === "n/a" || t === "na" || t === "none" || t === "null") return "";
  return t;
}

/** 创意作品类型归一化：上传路径精确映射中英文；数据库路径对 shop_content_type 防御性判断。 */
/** Map key used for every nickname/username alias lookup.  Country is mandatory. */
export function identityKey(country: string | null | undefined, normalizedName: string): string {
  const site = (country ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return `${site}\u001f${normalizedName}`;
}

export function splitIdentityKey(key: string): { country: string; normalizedName: string } {
  const at = key.indexOf("\u001f");
  return at < 0 ? { country: "", normalizedName: key } : { country: key.slice(0, at), normalizedName: key.slice(at + 1) };
}

export function normalizeCreativeType(raw: string | null | undefined): CreativeType {
  const s = (raw ?? "").trim();
  if (!s) return "unknown";
  const low = s.toLowerCase();
  if (low === "视频" || low === "video") return "video";
  if (low === "商品卡片" || low === "product card" || low === "商品卡") return "product_card";
  if (low === "直播" || low === "live") return "live";
  const up = s.toUpperCase();
  if (up.includes("CARD") || s.includes("商品卡")) return "product_card";
  if (up.includes("LIVE") || s.includes("直播")) return "live";
  if (up.includes("VIDEO") || s.includes("视频")) return "video";
  return "video";
}

/** TikTok 视频 ID 高 32 位 = Unix 秒时间戳（样本 99.7% 与实际发布时间 ±2 天吻合）。 */
export function vidToPostedAt(vid: string): Date | null {
  if (!/^\d{15,20}$/.test(vid)) return null;
  try {
    const sec = Number(BigInt(vid) >> 32n);
    // sanity: 2008-01-01 .. 2100-01-01
    if (sec < 1199145600 || sec > 4102444800) return null;
    const d = new Date(sec * 1000);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ---------- 类型 ----------

export type VidRegistration = {
  staff: string;
  role: Role;
  registerDate: string | null; // 'YYYY-MM-DD'
  country: string;
};

export type Handover = { fromBd: string; toBd: string; date: string }; // date: 'YYYY-MM-DD'

export type OwnershipRecord = { bd: string; keyType: "NICKNAME" | "HANDLE"; country: string };
export type AliasRecord = { bd: string; country: string };

export type AttrContext = {
  /** vid → 全部登记（staff_vid_map ∪ creator_registry 含归档） */
  vidRegs: Map<string, VidRegistration[]>;
  /** 归一化名 → 人工判定别名（creator_alias source=MANUAL），优先级最高 */
  manualAlias: Map<string, AliasRecord>;
  /** 归一化名 → 建联表归属（creator_ownership，NICKNAME 优先于 HANDLE 合并） */
  ownership: Map<string, OwnershipRecord>;
  /** 归一化名 → VID 推断别名（creator_alias source=VID_INFERRED） */
  vidAlias: Map<string, AliasRecord>;
  /** country → 交接记录（按日期升序） */
  handovers: Map<string, Handover[]>;
  /** review_key → 人工判定 BD（attribution_review.manual_bd） */
  reviewOverrides: Map<string, string>;
};

export type AttrInputRow = {
  key: string; // 月度: `${vid}|${acct}|...`；上传: `${upload_id}:${row_no}`
  creativeType: CreativeType;
  vid: string; // '' = 无 VID
  accountName: string; // 原文
  country: string; // 已知站点（数据库路径=广告户国家；上传路径=文件名站点），可为 ''
  postedAt: string | null; // ISO datetime
  postedAtSource: "sheet" | "meta" | "vid" | null;
  currency: string; // '' 视为 USD
  cost: number;
  grossRevenue: number;
  orders: number;
};

export type AttrRowResult = {
  key: string;
  bucket: Bucket;
  staff?: string;
  source?: Role;
  matchType?: MatchType;
  /** 有效站点：行自带国家，否则用归属记录的国家 */
  country: string;
  handoverApplied?: boolean;
};

export type ReviewItem = {
  reviewKey: string;
  type: "VID_DUAL_SOURCE" | "ALIAS_VOTE_CONFLICT" | "PROTECTION_GRAB" | "KEYTYPE_CONFLICT" | "HANDOVER_BOUNDARY";
  subject: string;
  detail: unknown;
  defaultResolution: string;
};

export type NewAlias = {
  aliasNorm: string;
  aliasDisplay: string;
  bd: string;
  country: string;
  evidenceVids: string[];
};

export type AttrRunResult = {
  rows: AttrRowResult[];
  reviews: ReviewItem[];
  newAliases: NewAlias[];
};

// ---------- 站点交接分段 ----------

function addMonthsISO(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * 站点交接：视频发布在交接日前归原 BD，之后归新 BD。
 * 正向（发布日 >= 交接日 且当前判定为原 BD → 转给新 BD，处理登记未更新的情况）；
 * 反向（发布日 < 交接日 且当前判定为新 BD → 归回原 BD，处理登记已更新的情况）。
 * postedAt 为 null 时视为「当前归属」，只做正向（全部交接生效）。
 */
export function applyHandover(
  baseBd: string,
  country: string,
  postedAt: string | null,
  handoversForCountry: Handover[] | undefined,
): { bd: string; applied: boolean } {
  if (!handoversForCountry?.length) return { bd: baseBd, applied: false };
  let bd = baseBd;
  const p = postedAt ? postedAt.slice(0, 10) : null;
  // 正向：按日期升序
  for (const h of handoversForCountry) {
    if ((p === null || p >= h.date) && bd === h.fromBd) bd = h.toBd;
  }
  if (p !== null) {
    // 反向：按日期降序
    for (let i = handoversForCountry.length - 1; i >= 0; i--) {
      const h = handoversForCountry[i];
      if (p < h.date && bd === h.toBd) bd = h.fromBd;
    }
  }
  return { bd, applied: bd !== baseBd };
}

/** 发布时间来自 VID 兜底且落在某交接日 ±N 天内 → 需要审查提示。 */
export function isHandoverBoundary(
  postedAt: string | null,
  postedAtSource: AttrInputRow["postedAtSource"],
  handoversForCountry: Handover[] | undefined,
  days = 5,
): Handover | null {
  if (!postedAt || postedAtSource !== "vid" || !handoversForCountry?.length) return null;
  const p = new Date(postedAt).getTime();
  for (const h of handoversForCountry) {
    const d = new Date(`${h.date}T00:00:00Z`).getTime();
    if (Math.abs(p - d) <= days * 86400 * 1000) return h;
  }
  return null;
}

// ---------- 保护期解析（昵称/用户名 → 当前 owner BD） ----------

export type RegistryEntry = {
  /** Unscoped normalized nickname/handle stored in the database. */
  matchKey?: string;
  staff: string;
  date: string | null; // register_date ?? sample_date
  sheet: string;
  rowNumber: number | null;
  display: string; // 原文昵称/用户名
  country: string;
};

export type OwnershipResolution = {
  matchKey: string;
  ownerBd: string;
  country: string;
  displayName: string;
  firstDate: string | null;
  ownerLastDate: string | null;
  transferCount: number;
  evidence: unknown;
};

/**
 * 每个 matchKey 独立解析：按登记日期升序迭代（无日期行排最前）。
 * owner=最早登记 BD；同 BD 再登记刷新最后建联日期；
 * 异 BD 登记距 owner 最后日期 ≥ protectionMonths 个月 → 归属转移，否则为保护期抢注（记审查项）。
 */
export function resolveOwnership(
  groups: Map<string, RegistryEntry[]>,
  keyType: "NICKNAME" | "HANDLE",
  protectionMonths = 3,
): { owners: OwnershipResolution[]; reviews: ReviewItem[] } {
  const owners: OwnershipResolution[] = [];
  const reviews: ReviewItem[] = [];

  for (const [matchKey, entriesRaw] of groups) {
    const entries = [...entriesRaw].sort((a, b) => {
      const da = a.date ?? "0000-00-00";
      const db = b.date ?? "0000-00-00";
      return da < db ? -1 : da > db ? 1 : 0;
    });
    let owner = "";
    let ownerLast: string | null = null;
    let firstDate: string | null = null;
    let transferCount = 0;
    const grabs: Array<{ bd: string; date: string | null; sheet: string; row: number | null }> = [];
    const timeline: Array<{ bd: string; date: string | null; sheet: string; row: number | null }> = [];

    for (const e of entries) {
      timeline.push({ bd: e.staff, date: e.date, sheet: e.sheet, row: e.rowNumber });
      if (!owner) {
        owner = e.staff;
        ownerLast = e.date;
        firstDate = e.date;
        continue;
      }
      if (e.staff === owner) {
        if (e.date && (!ownerLast || e.date > ownerLast)) ownerLast = e.date;
        continue;
      }
      // 异 BD 登记
      if (!ownerLast) {
        // owner 无任何日期记录，无法主张保护期 → 转移
        owner = e.staff;
        ownerLast = e.date;
        transferCount++;
      } else if (e.date && e.date >= addMonthsISO(ownerLast, protectionMonths)) {
        owner = e.staff;
        ownerLast = e.date;
        transferCount++;
      } else {
        grabs.push({ bd: e.staff, date: e.date, sheet: e.sheet, row: e.rowNumber });
      }
    }
    if (!owner) continue;

    const last = entries[entries.length - 1];
    owners.push({
      matchKey: entries[0]?.matchKey ?? matchKey,
      ownerBd: owner,
      country: last?.country ?? "",
      displayName: last?.display ?? matchKey,
      firstDate,
      ownerLastDate: ownerLast,
      transferCount,
      evidence: { timeline, grabs },
    });

    if (grabs.length) {
      reviews.push({
        reviewKey: `GRAB:${keyType}:${matchKey}`,
        type: "PROTECTION_GRAB",
        subject: last?.display ?? matchKey,
        detail: { keyType, owner, ownerLastDate: ownerLast, grabs },
        defaultResolution: `保护期内抢注无效，归属维持 ${owner}（最后建联 ${ownerLast ?? "无日期"}）`,
      });
    }
  }
  return { owners, reviews };
}

// ---------- 归因主流程 ----------

function pickVidOwner(
  vid: string,
  regs: VidRegistration[],
  reviewOverrides: Map<string, string>,
): { staff: string; role: Role; country: string; review: ReviewItem | null } {
  const distinctStaff = new Map<string, VidRegistration>();
  for (const r of regs) {
    const prev = distinctStaff.get(r.staff);
    // 同一同事多条登记取日期最新的
    if (!prev || (r.registerDate ?? "") > (prev.registerDate ?? "")) distinctStaff.set(r.staff, r);
  }
  const candidates = Array.from(distinctStaff.values());
  if (candidates.length === 1) {
    const c = candidates[0];
    return { staff: c.staff, role: c.role, country: c.country, review: null };
  }

  // 多个同事登记同一 VID → 审查项；人工判定优先，否则默认登记日期较新者（缺日期视为较旧，同分优先 BD）
  const reviewKey = `VID_DUAL:${vid}`;
  const override = reviewOverrides.get(reviewKey);
  let chosen: VidRegistration | undefined;
  if (override) chosen = candidates.find((c) => c.staff === override);
  if (!chosen) {
    chosen = [...candidates].sort((a, b) => {
      const da = a.registerDate ?? "0000-00-00";
      const db = b.registerDate ?? "0000-00-00";
      if (da !== db) return da > db ? -1 : 1;
      if (a.role !== b.role) return a.role === "BD" ? -1 : 1;
      return a.staff.localeCompare(b.staff);
    })[0];
  }
  const review: ReviewItem = {
    reviewKey,
    type: "VID_DUAL_SOURCE",
    subject: vid,
    detail: {
      candidates: candidates.map((c) => ({ staff: c.staff, role: c.role, registerDate: c.registerDate, country: c.country })),
      chosen: chosen.staff,
      overridden: !!override,
    },
    defaultResolution: override
      ? `人工判定归 ${chosen.staff}`
      : `默认取登记日期较新者 ${chosen.staff}（${chosen.role}）`,
  };
  return { staff: chosen.staff, role: chosen.role, country: chosen.country, review };
}

/**
 * 两阶段归因：
 * Pass 1 — 商品卡分桶 + VID 强匹配 + 别名投票收集；
 * 别名推断 — 票全指向同一 BD 且不与人工别名/建联归属冲突 → 新别名（当次生效）；
 * Pass 2 — 昵称路径（人工别名 > 建联归属 > VID 推断别名）+ 站点交接分段。
 */
export function attributeRows(rows: AttrInputRow[], ctx: AttrContext): AttrRunResult {
  const results: AttrRowResult[] = [];
  const reviewByKey = new Map<string, ReviewItem>();
  const pending: AttrInputRow[] = [];

  // norm → bd → Set<vid>（仅 BD 的 VID 强匹配行投票）
  const votes = new Map<string, Map<string, Set<string>>>();
  const displayByNorm = new Map<string, string>();
  // 交接边界聚合：country|date → 样本
  const boundaryAgg = new Map<string, { handover: Handover; count: number; samples: string[] }>();

  const noteBoundary = (row: AttrInputRow, country: string) => {
    const h = isHandoverBoundary(row.postedAt, row.postedAtSource, ctx.handovers.get(country));
    if (!h) return;
    const k = `${country}|${h.date}`;
    const agg = boundaryAgg.get(k) ?? { handover: h, count: 0, samples: [] };
    agg.count++;
    if (agg.samples.length < 20) agg.samples.push(row.vid || row.accountName);
    boundaryAgg.set(k, agg);
  };

  // ---- Pass 1 ----
  for (const row of rows) {
    if (row.creativeType === "product_card") {
      results.push({ key: row.key, bucket: "PRODUCT_CARD", country: row.country });
      continue;
    }
    const regs = row.vid ? ctx.vidRegs.get(row.vid) : undefined;
    if (regs?.length) {
      const picked = pickVidOwner(row.vid, regs, ctx.reviewOverrides);
      if (picked.review) reviewByKey.set(picked.review.reviewKey, picked.review);
      const country = row.country || picked.country || "";
      results.push({
        key: row.key,
        bucket: "STAFF",
        staff: picked.staff,
        source: picked.role,
        matchType: "VID",
        country,
      });
      // 别名投票：仅 BD 的 VID 匹配行
      const norm = normalizeName(row.accountName);
      const scoped = identityKey(row.country, norm);
      if (picked.role === "BD" && norm) {
        if (!displayByNorm.has(scoped)) displayByNorm.set(scoped, row.accountName.trim());
        const byBd = votes.get(scoped) ?? new Map<string, Set<string>>();
        const set = byBd.get(picked.staff) ?? new Set<string>();
        set.add(row.vid);
        byBd.set(picked.staff, set);
        votes.set(scoped, byBd);
      }
      continue;
    }
    pending.push(row);
  }

  // ---- 别名推断 ----
  const newAliases: NewAlias[] = [];
  const newAliasMap = new Map<string, AliasRecord>();
  for (const [scoped, byBd] of votes) {
    if (ctx.manualAlias.has(scoped)) continue;
    const { country, normalizedName: norm } = splitIdentityKey(scoped);
    const bds = Array.from(byBd.keys());
    const display = displayByNorm.get(scoped) ?? norm;
    if (bds.length > 1) {
      reviewByKey.set(`ALIAS:${scoped}`, {
        reviewKey: `ALIAS:${scoped}`,
        type: "ALIAS_VOTE_CONFLICT",
        subject: display,
        detail: {
          kind: "multi_bd",
          votes: bds.map((bd) => ({ bd, vids: Array.from(byBd.get(bd) ?? []).slice(0, 20), count: byBd.get(bd)?.size ?? 0 })),
        },
        defaultResolution: "别名不生效，未匹配行走建联表归属/无建联",
      });
      continue;
    }
    const bd = bds[0];
    const vids = Array.from(byBd.get(bd) ?? []);
    const own = ctx.ownership.get(scoped);
    if (own && own.bd !== bd) {
      reviewByKey.set(`ALIAS:${scoped}`, {
        reviewKey: `ALIAS:${scoped}`,
        type: "ALIAS_VOTE_CONFLICT",
        subject: display,
        detail: { kind: "vs_registry", vidEvidence: { bd, vids: vids.slice(0, 20) }, registryOwner: own.bd },
        defaultResolution: `与建联表归属冲突，默认按建联表归 ${own.bd}`,
      });
      continue;
    }
    if (own) continue; // 建联表已覆盖同一 BD，无需别名
    const existing = ctx.vidAlias.get(scoped);
    if (existing && existing.bd !== bd) {
      reviewByKey.set(`ALIAS:${scoped}`, {
        reviewKey: `ALIAS:${scoped}`,
        type: "ALIAS_VOTE_CONFLICT",
        subject: display,
        detail: { kind: "vs_existing_alias", newVote: { bd, vids: vids.slice(0, 20) }, existingBd: existing.bd },
        defaultResolution: `保持已有别名归 ${existing.bd}`,
      });
      continue;
    }
    // 站点：投票 VID 登记的国家（取任一）
    const anyVid = vids[0];
    const country = ctx.vidRegs.get(anyVid)?.find((r) => r.staff === bd)?.country ?? "";
    newAliases.push({ aliasNorm: norm, aliasDisplay: display, bd, country, evidenceVids: vids });
    newAliasMap.set(norm, { bd, country });
  }

  // ---- Pass 2：昵称路径（仅 BD）----
  for (const row of pending) {
    const norm = normalizeName(row.accountName);
    if (!norm) {
      results.push({ key: row.key, bucket: "UNMATCHED", country: row.country });
      continue;
    }
    const scoped = identityKey(row.country, norm);
    let bd = "";
    let matchType: MatchType | undefined;
    let recCountry = "";
    const manual = ctx.manualAlias.get(scoped);
    const own = ctx.ownership.get(scoped);
    const alias = ctx.vidAlias.get(scoped) ?? newAliasMap.get(scoped);
    if (manual) {
      bd = manual.bd;
      matchType = "ALIAS_MANUAL";
      recCountry = manual.country;
    } else if (own) {
      bd = own.bd;
      matchType = "REGISTRY";
      recCountry = own.country;
    } else if (alias) {
      bd = alias.bd;
      matchType = "ALIAS_VID";
      recCountry = alias.country;
    }
    if (!bd) {
      results.push({ key: row.key, bucket: "UNMATCHED", country: row.country });
      continue;
    }
    const country = row.country || recCountry || "";
    const hs = ctx.handovers.get(country);
    const { bd: finalBd, applied } = applyHandover(bd, country, row.postedAt, hs);
    if (applied || hs?.length) noteBoundary(row, country);
    results.push({
      key: row.key,
      bucket: "STAFF",
      staff: finalBd,
      source: "BD",
      matchType,
      country,
      handoverApplied: applied,
    });
  }

  // 交接边界审查项（聚合）
  for (const [k, agg] of boundaryAgg) {
    const [country, date] = k.split("|");
    reviewByKey.set(`HND:${k}`, {
      reviewKey: `HND:${k}`,
      type: "HANDOVER_BOUNDARY",
      subject: `${country} ${date} 交接（${agg.handover.fromBd}→${agg.handover.toBd}）`,
      detail: { country, date, count: agg.count, samples: agg.samples },
      defaultResolution: `${agg.count} 行发布时间来自 VID 推算且落在交接日 ±5 天内，可能误归，建议人工抽查`,
    });
  }

  return { rows: results, reviews: Array.from(reviewByKey.values()), newAliases };
}
