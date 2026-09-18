// GMV 归因引擎（纯函数，无 IO）。月度报表(attribution-run)与 Excel 上传(attribution-upload)共用。
//
// 【入库口径】广告表的每一行都入库，不筛掉任何内容类型，只是按「创意作品类型」分四类走不同的归因路径：
//   · 商品卡片 → PRODUCT_CARD 桶：不归人，但 GMV/成本照样统计，可按站点看占比
//   · 直播     → 只走达人昵称路径，且只归 BD（不走 VID 强匹配）
//   · 视频     → VID 强匹配（BD 与剪辑都可）+ 达人昵称路径（仅 BD）
//   · 其他     → OTHER 桶：不归人，同样保留 GMV/成本（类型无法识别时落这里，不再默认当成视频）
//
// 归因瀑布（一行数据全局只归一个人）：
//   1. 商品卡 → PRODUCT_CARD 桶；无法识别的类型 → OTHER 桶（都不归人）
//   2. VID 强匹配（staff_vid_map ∪ 授权记录归档，BD/EDITOR）→ 该同事；双登记冲突进审查表（直播不走这层）
//   3. 昵称路径（仅 BD）：人工别名 > 建联表归属（保护期解析）> VID 推断别名；再叠加站点交接分段
//   4. 都不中 → UNMATCHED（无建联达人）
//
// 站点匹配：昵称类查表 key = 「站点\u001f归一化名」，站点按字母精确匹配，**不做任何跨站点兜底**。
// 飞书建联表 C 列、剪辑表 D 列填的都是站点代码（PH / TH / VN / US / MX-AR…），与上传文件名解析出的站点同源。
// 名字对得上但站点对不上的行，一律归 UNMATCHED；这类行由 attribution-upload 的 `site_mismatch` action
// 单独列表出来供人工确认，不在归因里静默改判。

export type Role = "BD" | "EDITOR";
export type MatchType = "VID" | "ALIAS_MANUAL" | "REGISTRY" | "ALIAS_VID";
export type Bucket = "STAFF" | "PRODUCT_CARD" | "OTHER" | "UNMATCHED";
export type CreativeType = "video" | "product_card" | "live" | "other";

// ---------- 归一化 ----------

/** 昵称/用户名归一化：NFKC + trim + 空白折叠 + 小写；'-' / 'N/A' 等占位视为空。 */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (t === "-" || t === "n/a" || t === "na" || t === "none" || t === "null") return "";
  return t;
}

/** 创意作品类型归一化：上传路径精确映射中英文；数据库路径对 shop_content_type 防御性判断。 */
/**
 * 站点写法全系统统一用英文简写（PH / TH / VN / MY / SG / MX-AR / US / JP…）。
 * 含汉字 = 数据填错：归因不做任何汉字站点的匹配或换算，这类值永远匹配不上，只能在源头改。
 */
export function hasCjk(s: string | null | undefined): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s ?? "");
}

/**
 * 站点等效写法映射：极少数历史写法在飞书里已经沉淀了很多行，逐条改不现实，
 * 就在读取时归一到标准代码。**这不是「汉字匹配」**——只是把已知的旧写法翻译成代码，
 * 表里没列出的汉字站点一律不认，仍旧报错让人去飞书改。
 */
const SITE_ALIASES: Record<string, string> = {
  "PH本土": "PHL",
  "PH 本土": "PHL",
};

/**
 * 明显是表头/占位而不是站点的单元格。建联表有的 sheet 有多行表头，
 * 从 A2 开始读会把「地区/店铺」这种标题当成站点收进来，不该报成「汉字站点写法」。
 */
const SITE_HEADER_WORDS = new Set([
  "地区/店铺", "地区", "店铺", "国家", "站点", "国家/地区", "地区/国家", "站点/地区", "所属站点", "（空）", "(空)",
]);

export function isHeaderLikeSite(s: string | null | undefined): boolean {
  const t = (s ?? "").normalize("NFKC").trim().replace(/\s+/g, "");
  return t === "" || SITE_HEADER_WORDS.has(t);
}

/**
 * 站点归一：NFKC + trim + 折叠空白 + 大写，再套等效写法映射。
 * 归一后仍含汉字 = 数据填错，调用方负责计数并提示回飞书改，不做任何猜测性匹配。
 */
export function normalizeSiteCode(s: string | null | undefined): string {
  const t = (s ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const mapped = SITE_ALIASES[t] ?? SITE_ALIASES[t.toUpperCase()] ?? t;
  return mapped.toUpperCase();
}

/** Map key used for every nickname/username alias lookup.  Country is mandatory. */
export function identityKey(country: string | null | undefined, normalizedName: string): string {
  const site = (country ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return `${site}\u001f${normalizedName}`;
}

/**
 * 昵称类查表统一入口：「站点 + 归一化名」精确匹配，站点不同即视为不同的人，不做跨站点兜底。
 * （站点写法本身由 identityKey 归一：NFKC + trim + 折叠空白 + 大写。）
 */
export function lookupIdentity<T>(map: Map<string, T>, country: string, normalizedName: string): T | undefined {
  if (!normalizedName) return undefined;
  return map.get(identityKey(country, normalizedName));
}

export function splitIdentityKey(key: string): { country: string; normalizedName: string } {
  const at = key.indexOf("\u001f");
  return at < 0 ? { country: "", normalizedName: key } : { country: key.slice(0, at), normalizedName: key.slice(at + 1) };
}

/**
 * 创意作品类型归一化：**只做精确匹配**（中英文两种写法都列全）。
 *
 * 内容类型是 TikTok 导出的受控取值，不做任何包含式兜底：猜中一次不存在的写法，
 * 代价是真出现新类型时被静默归进已知类型、再也暴露不出来。
 * 认不出来的一律归 "other"（不归人但金额照样统计），在「内容类型」面板里看得见。
 * 与 src/lib/adExcel.ts 的 normCreativeType 同口径，两边改动必须同步。
 */
export function normalizeCreativeType(raw: string | null | undefined): CreativeType {
  const s = (raw ?? "").trim();
  if (!s) return "other";
  const low = s.toLowerCase();
  if (low === "视频" || low === "video") return "video";
  if (low === "商品卡片" || low === "product card" || low === "product_card" || low === "商品卡") return "product_card";
  if (low === "直播" || low === "live") return "live";
  return "other";
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

/**
 * 「谁在什么时候对哪个达人有过登记动作」。
 * key = identityKey(站点, 归一化名) → 同事 → 该同事对这个达人的全部登记动作日期（升序去重）。
 * 动作日期取 register_date，没有就退回 sample_date（发样）。站点交接判定要用它。
 */
export type CreatorActions = Map<string, Map<string, string[]>>;

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
  /** 达人登记动作时间线，站点交接按「新 BD 何时真正接手这个达人」判定 */
  creatorActions: CreatorActions;
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

// ---------- 日期与保护期 ----------

/**
 * 达人归属保护期 = **90 自然天**（2026-09-16 起，全系统统一，归因与报表同口径）。
 *
 * 之前是「3 个自然月」：月份长度不一，1/10 起算落在 4/10、3/1 起算落在 6/1，
 * 实际长度在 89–92 天之间来回漂，同一条规则在不同月份松紧不一样。改成自然天后边界唯一。
 *
 * 窗口是半开的 `[ownerLast, ownerLast+90)`：
 * 异 BD 动作落在窗口内 = 抢注无效（归属不变 + 记审查项）；
 * 落在窗口外（即距 ownerLast **满 90 天**）= 归属转移。
 * 从新动作日 D 往回看就是计划里写的 `[D-90, D)`，两种说法等价。
 */
export const PROTECTION_DAYS = 90;

/** 日期加天数（按 UTC 自然天，不受运行环境时区影响）。 */
export function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** b - a 的自然天数。 */
export function diffDays(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86400000);
}

// ---------- 站点交接分段 ----------

/** 某个同事对某个达人、在 `from`（含）之后的第一次登记动作日期；没有则返回 null。 */
function firstActionOnOrAfter(dates: string[] | undefined, from: string): string | null {
  if (!dates?.length) return null;
  for (const d of dates) if (d >= from) return d; // dates 已升序
  return null;
}

/**
 * 站点交接：**交接日只是「允许转移」的起点，不是转移生效日**。
 *
 * 真正的转移日 = 新 BD 在交接日（含）之后，对**这个具体达人**第一次产生登记动作（登记/发样）的日期。
 *   · 新 BD 没对这个达人动过手 → 这次交接对该达人永不生效，仍归原 BD（不因为交接日到了就批量转移历史达人）
 *   · 动过手 → 只有发布时间 ≥ 该转移日的行才切给新 BD，之前的行仍归原 BD
 *   · 发布时间未知（null）→ 视为「当前归属」，只要新 BD 动过手就按已转移处理
 *
 * 反向（发布日 < 转移日 但当前判定已是新 BD）→ 归回原 BD，处理登记已更新、但视频是交接前发的情况。
 * 这条规则只作用于昵称/账号路径，VID 强匹配不受影响（VID 是谁登记的就是谁的）。
 */
export function applyHandover(
  baseBd: string,
  country: string,
  normalizedName: string,
  postedAt: string | null,
  handoversForCountry: Handover[] | undefined,
  creatorActions?: CreatorActions,
): { bd: string; applied: boolean; transferDate: string | null; handover: Handover | null } {
  if (!handoversForCountry?.length) return { bd: baseBd, applied: false, transferDate: null, handover: null };

  const actions = normalizedName ? creatorActions?.get(identityKey(country, normalizedName)) : undefined;
  /** 这次交接对该达人的实际转移日；null = 新 BD 没接手过，这次交接不生效 */
  const transferDateOf = (h: Handover) => firstActionOnOrAfter(actions?.get(h.toBd), h.date);

  let bd = baseBd;
  const p = postedAt ? postedAt.slice(0, 10) : null;
  let transferDate: string | null = null;
  let hit: Handover | null = null;

  // 正向：按日期升序
  for (const h of handoversForCountry) {
    if (bd !== h.fromBd) continue;
    const t = transferDateOf(h);
    if (!t) continue; // 新 BD 从未接手这个达人 → 交接不生效
    if (p === null || p >= t) {
      bd = h.toBd;
      transferDate = t;
      hit = h;
    }
  }

  if (p !== null) {
    // 反向：按日期降序。同样只在新 BD 确实接手过的前提下才回拨
    for (let i = handoversForCountry.length - 1; i >= 0; i--) {
      const h = handoversForCountry[i];
      if (bd !== h.toBd) continue;
      const t = transferDateOf(h);
      if (!t) continue;
      if (p < t) {
        bd = h.fromBd;
        transferDate = t;
        hit = h;
      }
    }
  }

  return { bd, applied: bd !== baseBd, transferDate, handover: hit };
}

/**
 * 发布时间来自 VID 推算、且落在**实际转移日** ±N 天内 → 需要人工抽查。
 * 注意这里用的是转移日（新 BD 首次接手该达人的日期），不是交接表上的交接日 ——
 * 提示必须落在真正会改判的那个时间点上，否则等于提示在一个不会发生切换的日期附近。
 */
export function isHandoverBoundary(
  postedAt: string | null,
  postedAtSource: AttrInputRow["postedAtSource"],
  transferDate: string | null,
  days = 5,
): boolean {
  if (!postedAt || postedAtSource !== "vid" || !transferDate) return false;
  const p = new Date(postedAt).getTime();
  const d = new Date(`${transferDate}T00:00:00Z`).getTime();
  return Math.abs(p - d) <= days * 86400 * 1000;
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
 * 异 BD 登记距 owner 最后日期 ≥ protectionDays 个自然天 → 归属转移，否则为保护期抢注（记审查项）。
 */
export function resolveOwnership(
  groups: Map<string, RegistryEntry[]>,
  keyType: "NICKNAME" | "HANDLE",
  protectionDays = PROTECTION_DAYS,
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
      } else if (e.date && diffDays(ownerLast, e.date) >= protectionDays) {
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
        defaultResolution: `保护期（90 自然天）内抢注无效，归属维持 ${owner}（最后建联 ${ownerLast ?? "无日期"}）`,
      });
    }
  }
  return { owners, reviews };
}

/**
 * 归属分类：把 (桶, 角色, 匹配方式) 折成月度 Excel 流程「归属角色」列那五档，两边对数据不用再互相翻译。
 * 「其他」是本系统后加的桶（创意类型认不出来的行），Excel 流程里没有对应项。
 */
export type OwnershipClass = "商品卡片" | "剪辑" | "BD-VID" | "BD-账号" | "未建联达人" | "其他";

export function classifyAttribution(
  bucket: Bucket,
  role?: Role | null,
  matchType?: MatchType | null,
): OwnershipClass {
  if (bucket === "PRODUCT_CARD") return "商品卡片";
  if (bucket === "OTHER") return "其他";
  if (bucket !== "STAFF") return "未建联达人";
  if (role === "EDITOR") return "剪辑";
  return matchType === "VID" ? "BD-VID" : "BD-账号";
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
  // 交接边界聚合：country|实际转移日 → 样本
  const boundaryAgg = new Map<string, { handover: Handover; transferDate: string; count: number; samples: string[] }>();

  // ---- Pass 1 ----
  for (const row of rows) {
    // 商品卡与无法识别的类型：不归人，但金额已经在库里，报表按桶单独展示
    if (row.creativeType === "product_card") {
      results.push({ key: row.key, bucket: "PRODUCT_CARD", country: row.country });
      continue;
    }
    if (row.creativeType === "other") {
      results.push({ key: row.key, bucket: "OTHER", country: row.country });
      continue;
    }
    // 直播只按达人名称归 BD，不走 VID 强匹配（直播的 VID 不代表达人归属）
    if (row.creativeType === "live") {
      pending.push(row);
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
    const { country: aliasCountry, normalizedName: norm } = splitIdentityKey(scoped);
    if (lookupIdentity(ctx.manualAlias, aliasCountry, norm)) continue;
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
    const own = lookupIdentity(ctx.ownership, aliasCountry, norm);
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
    const existing = lookupIdentity(ctx.vidAlias, aliasCountry, norm);
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
    // 站点：优先使用投票时的行站点，兜底取 VID 登记站点。
    const anyVid = vids[0];
    const country = aliasCountry || (ctx.vidRegs.get(anyVid)?.find((r) => r.staff === bd)?.country ?? "");
    newAliases.push({ aliasNorm: norm, aliasDisplay: display, bd, country, evidenceVids: vids });
    newAliasMap.set(scoped, { bd, country });
  }

  // ---- Pass 2：昵称路径（仅 BD）----
  for (const row of pending) {
    const norm = normalizeName(row.accountName);
    if (!norm) {
      results.push({ key: row.key, bucket: "UNMATCHED", country: row.country });
      continue;
    }
    let bd = "";
    let matchType: MatchType | undefined;
    let recCountry = "";
    const manual = lookupIdentity(ctx.manualAlias, row.country, norm);
    const own = lookupIdentity(ctx.ownership, row.country, norm);
    const alias = lookupIdentity(ctx.vidAlias, row.country, norm) ?? lookupIdentity(newAliasMap, row.country, norm);
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
    const { bd: finalBd, applied, transferDate, handover } = applyHandover(
      bd,
      country,
      norm,
      row.postedAt,
      hs,
      ctx.creatorActions,
    );
    // 发布时间是 VID 推算出来的、又正好卡在实际转移日附近 → 记一条抽查提示
    if (handover && transferDate && isHandoverBoundary(row.postedAt, row.postedAtSource, transferDate)) {
      const k = `${country}|${transferDate}`;
      const agg = boundaryAgg.get(k) ?? { handover, transferDate, count: 0, samples: [] };
      agg.count++;
      if (agg.samples.length < 20) agg.samples.push(row.vid || row.accountName);
      boundaryAgg.set(k, agg);
    }
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
    const [country] = k.split("|");
    reviewByKey.set(`HND:${k}`, {
      reviewKey: `HND:${k}`,
      type: "HANDOVER_BOUNDARY",
      subject: `${country} ${agg.transferDate} 实际转移（${agg.handover.fromBd}→${agg.handover.toBd}，交接表日期 ${agg.handover.date}）`,
      detail: {
        country,
        transferDate: agg.transferDate,
        handoverDate: agg.handover.date,
        count: agg.count,
        samples: agg.samples,
      },
      defaultResolution: `${agg.count} 行发布时间来自 VID 推算且落在实际转移日 ±5 天内，可能误归，建议人工抽查`,
    });
  }

  return { rows: results, reviews: Array.from(reviewByKey.values()), newAliases };
}
