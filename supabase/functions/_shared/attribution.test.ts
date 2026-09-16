// 归因纯函数测试（Deno.test，零依赖，不引 vitest/jest）。
//
// 【这份测试固化的是「2026-09-16 的现有行为」，不是 V3 规范的目标行为。】
// GMV_ATTRIBUTION_V3_PLAN 阶段 1 的用意就是先把现状钉死：阶段 3 每改一条规则，
// 就把对应用例从「现状」改成「新规范」，改动影响一眼可见。
// 凡是与 V3 规范不一致的现状，用例里都用 `// V3:` 注明将来要改成什么。
//
// 跑法（仓库根目录）：
//   deno test supabase/functions/_shared/attribution.test.ts
import {
  type AttrContext,
  type AttrInputRow,
  type Handover,
  type RegistryEntry,
  applyHandover,
  attributeRows,
  classifyAttribution,
  hasCjk,
  identityKey,
  isHandoverBoundary,
  isHeaderLikeSite,
  lookupIdentity,
  normalizeCreativeType,
  normalizeName,
  normalizeSiteCode,
  resolveOwnership,
  splitIdentityKey,
  vidToPostedAt,
} from "./attribution.ts";

// ---------- 零依赖断言 ----------
// 不引 std/assert：deno.land 在部分运行环境（含本仓库的云端会话）不可达，
// 测试本身只需要这两个断言，自带实现比多一个远程依赖更稳。

function assert(cond: unknown, msg = "断言失败"): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? msg + "：" : ""}实际 ${a} ≠ 预期 ${e}`);
}

// ---------- normalizeName ----------

Deno.test("normalizeName: NFKC + trim + 折叠空白 + 小写", () => {
  assertEquals(normalizeName("  Wang   Jie  "), "wang jie");
  assertEquals(normalizeName("ＷＡＮＧ８８８"), "wang888"); // 全角 → 半角
  assertEquals(normalizeName("王姐\t好物"), "王姐 好物");
});

Deno.test("normalizeName: 占位值视为空", () => {
  for (const v of [null, undefined, "", "  ", "-", "N/A", "n/a", "NA", "none", "NULL"]) {
    assertEquals(normalizeName(v), "", `占位值 ${String(v)} 应归一成空`);
  }
});

// ---------- 站点 ----------

Deno.test("normalizeSiteCode: 大写 + 折叠空白 + 等效写法映射", () => {
  assertEquals(normalizeSiteCode(" ph "), "PH");
  assertEquals(normalizeSiteCode("mx-ar"), "MX-AR");
  assertEquals(normalizeSiteCode("PH本土"), "PHL"); // SITE_ALIASES
  assertEquals(normalizeSiteCode("PH 本土"), "PHL");
  assertEquals(normalizeSiteCode(""), "");
  assertEquals(normalizeSiteCode(null), "");
});

Deno.test("hasCjk / isHeaderLikeSite：汉字站点是数据填错，表头词不算站点", () => {
  assert(hasCjk("菲律宾"));
  assert(!hasCjk("PH"));
  assert(isHeaderLikeSite("地区/店铺"));
  assert(isHeaderLikeSite(""));
  assert(!isHeaderLikeSite("PH"));
});

Deno.test("identityKey / splitIdentityKey：站点必带，往返一致", () => {
  const k = identityKey("ph", "wang888");
  assertEquals(k, "PHwang888");
  assertEquals(splitIdentityKey(k), { country: "PH", normalizedName: "wang888" });
  // 站点不同即视为不同的人，不做跨站点兜底
  assert(identityKey("PH", "x") !== identityKey("PH2", "x"));
});

Deno.test("lookupIdentity：空名字永不命中", () => {
  const m = new Map([[identityKey("PH", "wang888"), 1]]);
  assertEquals(lookupIdentity(m, "PH", "wang888"), 1);
  assertEquals(lookupIdentity(m, "PH2", "wang888"), undefined);
  assertEquals(lookupIdentity(m, "PH", ""), undefined);
});

// ---------- 创意类型 ----------

Deno.test("normalizeCreativeType: 中英文精确值 + 包含式兜底", () => {
  assertEquals(normalizeCreativeType("视频"), "video");
  assertEquals(normalizeCreativeType("Video"), "video");
  assertEquals(normalizeCreativeType("商品卡片"), "product_card");
  assertEquals(normalizeCreativeType("Product Card"), "product_card");
  assertEquals(normalizeCreativeType("直播"), "live");
  assertEquals(normalizeCreativeType("LIVE_ROOM"), "live");
  // 认不出来的一律 other（不再默认当视频）
  assertEquals(normalizeCreativeType("图文"), "other");
  assertEquals(normalizeCreativeType(""), "other");
  assertEquals(normalizeCreativeType(null), "other");
});

// ---------- vidToPostedAt ----------

Deno.test("vidToPostedAt: 高 32 位 = Unix 秒，越界/非法返回 null", () => {
  const d = vidToPostedAt("7400000000000000000");
  assert(d instanceof Date);
  // UTC 时间戳（V3：归因不再使用它，只留给 isHandoverBoundary 抽查提示）
  assertEquals(d!.toISOString().slice(0, 4), "2024");
  assertEquals(vidToPostedAt("123"), null); // 位数不够
  assertEquals(vidToPostedAt("abc"), null);
  assertEquals(vidToPostedAt("100000000000000000"), null); // 换算出来早于 2008
});

// ---------- classifyAttribution ----------

Deno.test("classifyAttribution: 桶/角色/匹配方式 → 归属角色", () => {
  assertEquals(classifyAttribution("PRODUCT_CARD"), "商品卡片");
  assertEquals(classifyAttribution("OTHER"), "其他");
  assertEquals(classifyAttribution("UNMATCHED"), "未建联达人");
  assertEquals(classifyAttribution("STAFF", "EDITOR", "VID"), "剪辑");
  assertEquals(classifyAttribution("STAFF", "BD", "VID"), "BD-VID");
  assertEquals(classifyAttribution("STAFF", "BD", "REGISTRY"), "BD-账号");
  assertEquals(classifyAttribution("STAFF", "BD", "ALIAS_MANUAL"), "BD-账号");
  // V3 §六：将来要拆成一级 4 类 / 二级 8 类，并与 SQL 侧 attribution_ownership_class() 一一对应
});

// ---------- resolveOwnership ----------

function entry(staff: string, date: string | null, extra: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    matchKey: "wang888",
    staff,
    date,
    sheet: "建联-" + staff,
    rowNumber: 2,
    display: "王姐好物",
    country: "PH",
    ...extra,
  };
}

Deno.test("resolveOwnership: owner = 最早登记 BD，同 BD 再登记刷新最后建联日", () => {
  const groups = new Map([[
    identityKey("PH", "wang888"),
    [entry("李汝华", "2026-01-10"), entry("李汝华", "2026-03-01")],
  ]]);
  const { owners, reviews } = resolveOwnership(groups, "NICKNAME");
  assertEquals(owners.length, 1);
  assertEquals(owners[0].ownerBd, "李汝华");
  assertEquals(owners[0].firstDate, "2026-01-10");
  assertEquals(owners[0].ownerLastDate, "2026-03-01");
  assertEquals(owners[0].transferCount, 0);
  assertEquals(reviews.length, 0);
});

Deno.test("resolveOwnership: 异 BD 登记满保护期 → 转移", () => {
  // 现状：保护期 = 3 个「自然月」（addMonthsISO），不是 90 天
  // V3 §八 3.3：改成 90 自然天、窗口 [D-90, D)
  const groups = new Map([[
    identityKey("PH", "wang888"),
    [entry("李汝华", "2026-01-10"), entry("何莎莎", "2026-04-10")],
  ]]);
  const { owners, reviews } = resolveOwnership(groups, "NICKNAME");
  assertEquals(owners[0].ownerBd, "何莎莎");
  assertEquals(owners[0].transferCount, 1);
  assertEquals(reviews.length, 0);
});

Deno.test("resolveOwnership: 保护期内抢注 → 归属不变 + PROTECTION_GRAB 审查项", () => {
  const groups = new Map([[
    identityKey("PH", "wang888"),
    [entry("李汝华", "2026-01-10"), entry("何莎莎", "2026-02-01")],
  ]]);
  const { owners, reviews } = resolveOwnership(groups, "NICKNAME");
  assertEquals(owners[0].ownerBd, "李汝华");
  assertEquals(owners[0].transferCount, 0);
  assertEquals(reviews.length, 1);
  assertEquals(reviews[0].type, "PROTECTION_GRAB");
  assertEquals(reviews[0].reviewKey, "GRAB:NICKNAME:PHwang888");
});

Deno.test("resolveOwnership: 无日期行排最前；owner 无日期时异 BD 直接转移", () => {
  const groups = new Map([[
    identityKey("PH", "wang888"),
    [entry("何莎莎", "2026-02-01"), entry("李汝华", null)],
  ]]);
  const { owners } = resolveOwnership(groups, "NICKNAME");
  // 无日期排序在前 → 李汝华先成为 owner，但无 ownerLast 无法主张保护期 → 转给何莎莎
  assertEquals(owners[0].ownerBd, "何莎莎");
  assertEquals(owners[0].transferCount, 1);
  assertEquals(owners[0].firstDate, null);
});

Deno.test("resolveOwnership: 保护期月数可调，边界为「≥ 起始日 + N 月」", () => {
  const mk = (d: string) =>
    new Map([[identityKey("PH", "wang888"), [entry("李汝华", "2026-01-10"), entry("何莎莎", d)]]]);
  // 恰好 3 个月 → 转移
  assertEquals(resolveOwnership(mk("2026-04-10"), "NICKNAME").owners[0].ownerBd, "何莎莎");
  // 差一天 → 抢注
  assertEquals(resolveOwnership(mk("2026-04-09"), "NICKNAME").owners[0].ownerBd, "李汝华");
  // 参数化
  assertEquals(resolveOwnership(mk("2026-04-10"), "NICKNAME", 6).owners[0].ownerBd, "李汝华");
});

// ---------- applyHandover ----------

const HANDOVER: Handover[] = [{ fromBd: "阿木", toBd: "李汝华", date: "2026-07-01" }];

/** creatorActions: identityKey(站点, 归一化名) → staff → 升序日期 */
function actions(pairs: Array<[string, string[]]>, normalizedName = "wang888", country = "PH") {
  return new Map([[identityKey(country, normalizedName), new Map(pairs)]]);
}

Deno.test("applyHandover: 新 BD 从未接手这个达人 → 交接不生效", () => {
  const r = applyHandover("阿木", "PH", "wang888", "2026-08-01", HANDOVER, actions([["阿木", ["2026-01-01"]]]));
  assertEquals(r.bd, "阿木");
  assertEquals(r.applied, false);
  assertEquals(r.transferDate, null);
});

Deno.test("applyHandover: 转移日 = 新 BD 在交接日之后对该达人的首次动作", () => {
  const act = actions([["李汝华", ["2026-06-01", "2026-07-20"]]]);
  // 交接日 7-1 之前的 6-01 不算，取 7-20
  const after = applyHandover("阿木", "PH", "wang888", "2026-08-01", HANDOVER, act);
  assertEquals(after.bd, "李汝华");
  assertEquals(after.applied, true);
  assertEquals(after.transferDate, "2026-07-20");
  // 发布时间早于转移日 → 仍归原 BD
  const before = applyHandover("阿木", "PH", "wang888", "2026-07-10", HANDOVER, act);
  assertEquals(before.bd, "阿木");
  assertEquals(before.applied, false);
});

Deno.test("applyHandover: 发布时间未知 → 按「当前归属」处理，即已转移", () => {
  const r = applyHandover("阿木", "PH", "wang888", null, HANDOVER, actions([["李汝华", ["2026-07-20"]]]));
  assertEquals(r.bd, "李汝华");
  assertEquals(r.applied, true);
  // V3 §四：无 posted_site_date 且无 VID 归因的行将改为进 PENDING，不再走这条兜底
});

Deno.test("applyHandover: 反向回拨 —— 登记已更新但视频发在交接前", () => {
  const r = applyHandover("李汝华", "PH", "wang888", "2026-05-01", HANDOVER, actions([["李汝华", ["2026-07-20"]]]));
  assertEquals(r.bd, "阿木");
  assertEquals(r.applied, true);
  assertEquals(r.transferDate, "2026-07-20");
});

Deno.test("applyHandover: 无交接记录 / 空名字 → 原样返回", () => {
  assertEquals(applyHandover("阿木", "PH", "wang888", "2026-08-01", undefined, undefined).bd, "阿木");
  assertEquals(applyHandover("阿木", "PH", "", "2026-08-01", HANDOVER, actions([["李汝华", ["2026-07-20"]]])).bd, "阿木");
});

Deno.test("applyHandover: 链式交接按日期升序逐段应用", () => {
  const chain: Handover[] = [
    { fromBd: "阿木", toBd: "李汝华", date: "2026-07-01" },
    { fromBd: "李汝华", toBd: "何莎莎", date: "2026-09-15" },
  ];
  const act = actions([["李汝华", ["2026-07-20"]], ["何莎莎", ["2026-09-20"]]]);
  assertEquals(applyHandover("阿木", "PH", "wang888", "2026-10-01", chain, act).bd, "何莎莎");
  assertEquals(applyHandover("阿木", "PH", "wang888", "2026-08-01", chain, act).bd, "李汝华");
  assertEquals(applyHandover("阿木", "PH", "wang888", "2026-06-01", chain, act).bd, "阿木");
});

// ---------- isHandoverBoundary ----------

Deno.test("isHandoverBoundary: 仅 VID 推算来源、且落在转移日 ±5 天内", () => {
  assert(isHandoverBoundary("2026-07-18T00:00:00Z", "vid", "2026-07-20"));
  assert(!isHandoverBoundary("2026-07-01T00:00:00Z", "vid", "2026-07-20"));
  assert(!isHandoverBoundary("2026-07-18T00:00:00Z", "sheet", "2026-07-20"));
  assert(!isHandoverBoundary(null, "vid", "2026-07-20"));
  assert(!isHandoverBoundary("2026-07-18T00:00:00Z", "vid", null));
});

// ---------- attributeRows（端到端瀑布）----------

function ctx(over: Partial<AttrContext> = {}): AttrContext {
  return {
    vidRegs: new Map(),
    manualAlias: new Map(),
    ownership: new Map(),
    vidAlias: new Map(),
    handovers: new Map(),
    creatorActions: new Map(),
    reviewOverrides: new Map(),
    ...over,
  };
}

function row(over: Partial<AttrInputRow> = {}): AttrInputRow {
  return {
    key: "k1",
    creativeType: "video",
    vid: "7400000000000000000",
    accountName: "王姐好物",
    country: "PH",
    postedAt: "2026-08-01T00:00:00Z",
    postedAtSource: "sheet",
    currency: "USD",
    cost: 1,
    grossRevenue: 10,
    orders: 1,
    ...over,
  };
}

Deno.test("attributeRows: 商品卡 / 其他类型不归人", () => {
  const { rows } = attributeRows(
    [row({ key: "a", creativeType: "product_card" }), row({ key: "b", creativeType: "other" })],
    ctx(),
  );
  assertEquals(rows.map((r) => r.bucket), ["PRODUCT_CARD", "OTHER"]);
});

Deno.test("attributeRows: VID 强归因全局生效（登记站点与行站点不同也命中）", () => {
  const vidRegs = new Map([[
    "7400000000000000000",
    [{ staff: "阿南", role: "EDITOR" as const, registerDate: "2026-05-01", country: "VN" }],
  ]]);
  const { rows } = attributeRows([row({ country: "PH" })], ctx({ vidRegs }));
  assertEquals(rows[0].bucket, "STAFF");
  assertEquals(rows[0].staff, "阿南");
  assertEquals(rows[0].source, "EDITOR");
  assertEquals(rows[0].matchType, "VID");
  assertEquals(rows[0].country, "PH"); // 行站点优先
  // V3 §3.5：VID 强归因维持全局，身份层才按站点隔离 —— 这是有意保留的差异
});

Deno.test("attributeRows: 直播不走 VID 强归因，只走昵称路径", () => {
  const vidRegs = new Map([[
    "7400000000000000000",
    [{ staff: "阿南", role: "EDITOR" as const, registerDate: "2026-05-01", country: "PH" }],
  ]]);
  const { rows } = attributeRows([row({ creativeType: "live" })], ctx({ vidRegs }));
  assertEquals(rows[0].bucket, "UNMATCHED");
});

Deno.test("attributeRows: 一个 VID 两个同事登记 → VID_DUAL_SOURCE，默认取登记日较新者", () => {
  const vidRegs = new Map([[
    "7400000000000000000",
    [
      { staff: "李汝华", role: "BD" as const, registerDate: "2026-05-01", country: "PH" },
      { staff: "何莎莎", role: "BD" as const, registerDate: "2026-06-01", country: "PH" },
    ],
  ]]);
  const { rows, reviews } = attributeRows([row()], ctx({ vidRegs }));
  assertEquals(rows[0].staff, "何莎莎");
  assertEquals(reviews.length, 1);
  assertEquals(reviews[0].type, "VID_DUAL_SOURCE");
  assertEquals(reviews[0].reviewKey, "VID_DUAL:7400000000000000000");
});

Deno.test("attributeRows: VID_DUAL_SOURCE 的人工判定优先于默认规则", () => {
  const vidRegs = new Map([[
    "7400000000000000000",
    [
      { staff: "李汝华", role: "BD" as const, registerDate: "2026-05-01", country: "PH" },
      { staff: "何莎莎", role: "BD" as const, registerDate: "2026-06-01", country: "PH" },
    ],
  ]]);
  const reviewOverrides = new Map([["VID_DUAL:7400000000000000000", "李汝华"]]);
  const { rows } = attributeRows([row()], ctx({ vidRegs, reviewOverrides }));
  assertEquals(rows[0].staff, "李汝华");
});

Deno.test("attributeRows: pickVidOwner 按姓名去重（双角色 bug，V3 7.3 要改成 staff+role）", () => {
  // 阿南既以剪辑身份、又以 BD 身份登记过同一 VID：
  // 现状按姓名折叠成一条并取日期较新者 → 角色被判成 BD，且不产生 VID_DUAL_SOURCE 审查项
  const vidRegs = new Map([[
    "7400000000000000000",
    [
      { staff: "阿南", role: "EDITOR" as const, registerDate: "2026-05-01", country: "VN" },
      { staff: "阿南", role: "BD" as const, registerDate: "2026-06-01", country: "VN" },
    ],
  ]]);
  const { rows, reviews } = attributeRows([row({ country: "VN" })], ctx({ vidRegs }));
  assertEquals(rows[0].staff, "阿南");
  assertEquals(rows[0].source, "BD"); // V3 7.3：改成 staff+role 去重后这里应产生 VID_DUAL_SOURCE 审查项
  assertEquals(reviews.length, 0);
});

Deno.test("attributeRows: 昵称路径优先级 人工别名 > 建联归属 > VID 推断别名", () => {
  const norm = normalizeName("王姐好物");
  const base = {
    manualAlias: new Map([[identityKey("PH", norm), { bd: "手动", country: "PH" }]]),
    ownership: new Map([[identityKey("PH", norm), { bd: "建联", keyType: "NICKNAME" as const, country: "PH" }]]),
    vidAlias: new Map([[identityKey("PH", norm), { bd: "别名", country: "PH" }]]),
  };
  const r0 = attributeRows([row({ vid: "" })], ctx(base)).rows[0];
  assertEquals([r0.staff, r0.matchType], ["手动", "ALIAS_MANUAL"]);
  const r1 = attributeRows([row({ vid: "" })], ctx({ ...base, manualAlias: new Map() })).rows[0];
  assertEquals([r1.staff, r1.matchType], ["建联", "REGISTRY"]);
  const r2 = attributeRows([row({ vid: "" })], ctx({ ...base, manualAlias: new Map(), ownership: new Map() })).rows[0];
  assertEquals([r2.staff, r2.matchType], ["别名", "ALIAS_VID"]);
});

Deno.test("attributeRows: 站点对不上不做跨站点兜底 → UNMATCHED", () => {
  const norm = normalizeName("王姐好物");
  const ownership = new Map([[identityKey("PH", norm), { bd: "李汝华", keyType: "NICKNAME" as const, country: "PH" }]]);
  const { rows } = attributeRows([row({ vid: "", country: "PH2" })], ctx({ ownership }));
  assertEquals(rows[0].bucket, "UNMATCHED");
});

Deno.test("attributeRows: 账号名为空 → UNMATCHED", () => {
  const { rows } = attributeRows([row({ vid: "", accountName: "-" })], ctx());
  assertEquals(rows[0].bucket, "UNMATCHED");
});

Deno.test("attributeRows: 别名投票 —— 同一 BD 的 VID 命中行推断出新别名", () => {
  const vidRegs = new Map([[
    "7400000000000000000",
    [{ staff: "李汝华", role: "BD" as const, registerDate: "2026-05-01", country: "PH" }],
  ]]);
  const { newAliases, rows } = attributeRows(
    [row({ key: "a" }), row({ key: "b", vid: "", accountName: "王姐好物" })],
    ctx({ vidRegs }),
  );
  assertEquals(newAliases.length, 1);
  assertEquals(newAliases[0].bd, "李汝华");
  assertEquals(newAliases[0].aliasNorm, normalizeName("王姐好物"));
  // 当次生效：无 VID 的那行立刻用上新别名
  assertEquals(rows[1].staff, "李汝华");
  assertEquals(rows[1].matchType, "ALIAS_VID");
  // V3 §事实 2：将来别名要改成「别名 → 达人实体 → 按发布时间查区间」，不再直接定 BD
});

Deno.test("attributeRows: 同一昵称投给两个 BD → ALIAS_VOTE_CONFLICT，别名不生效", () => {
  const vidRegs = new Map([
    ["7400000000000000001", [{ staff: "李汝华", role: "BD" as const, registerDate: "2026-05-01", country: "PH" }]],
    ["7400000000000000002", [{ staff: "何莎莎", role: "BD" as const, registerDate: "2026-05-01", country: "PH" }]],
  ]);
  const { newAliases, reviews } = attributeRows(
    [row({ key: "a", vid: "7400000000000000001" }), row({ key: "b", vid: "7400000000000000002" })],
    ctx({ vidRegs }),
  );
  assertEquals(newAliases.length, 0);
  assertEquals(reviews.filter((r) => r.type === "ALIAS_VOTE_CONFLICT").length, 1);
});

Deno.test("attributeRows: 投票与建联表归属冲突 → 审查项，按建联表", () => {
  const norm = normalizeName("王姐好物");
  const vidRegs = new Map([[
    "7400000000000000000",
    [{ staff: "李汝华", role: "BD" as const, registerDate: "2026-05-01", country: "PH" }],
  ]]);
  const ownership = new Map([[identityKey("PH", norm), { bd: "何莎莎", keyType: "NICKNAME" as const, country: "PH" }]]);
  const { reviews, newAliases, rows } = attributeRows(
    [row({ key: "a" }), row({ key: "b", vid: "" })],
    ctx({ vidRegs, ownership }),
  );
  assertEquals(newAliases.length, 0);
  assertEquals(reviews.filter((r) => r.type === "ALIAS_VOTE_CONFLICT").length, 1);
  assertEquals(rows[1].staff, "何莎莎");
});

Deno.test("attributeRows: 昵称路径叠加站点交接分段", () => {
  const norm = normalizeName("王姐好物");
  const ownership = new Map([[identityKey("PH", norm), { bd: "阿木", keyType: "NICKNAME" as const, country: "PH" }]]);
  const handovers = new Map([["PH", HANDOVER]]);
  const creatorActions = actions([["李汝华", ["2026-07-20"]]], norm);
  const after = attributeRows([row({ vid: "", postedAt: "2026-08-01T00:00:00Z" })], ctx({ ownership, handovers, creatorActions })).rows[0];
  assertEquals(after.staff, "李汝华");
  assertEquals(after.handoverApplied, true);
  const before = attributeRows([row({ vid: "", postedAt: "2026-07-10T00:00:00Z" })], ctx({ ownership, handovers, creatorActions })).rows[0];
  assertEquals(before.staff, "阿木");
});

Deno.test("attributeRows: VID 推算发布时间卡在转移日附近 → HANDOVER_BOUNDARY 抽查项（聚合）", () => {
  const norm = normalizeName("王姐好物");
  const ownership = new Map([[identityKey("PH", norm), { bd: "阿木", keyType: "NICKNAME" as const, country: "PH" }]]);
  const handovers = new Map([["PH", HANDOVER]]);
  const creatorActions = actions([["李汝华", ["2026-07-20"]]], norm);
  const { reviews } = attributeRows(
    [row({ vid: "", postedAt: "2026-07-21T00:00:00Z", postedAtSource: "vid" })],
    ctx({ ownership, handovers, creatorActions }),
  );
  const b = reviews.filter((r) => r.type === "HANDOVER_BOUNDARY");
  assertEquals(b.length, 1);
  assertEquals(b[0].reviewKey, "HND:PH|2026-07-20");
});
