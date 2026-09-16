// 身份层 + 归属区间的纯函数测试。编号对应 GMV_ATTRIBUTION_V3_PLAN §九测试矩阵。
// 跑法：deno test supabase/functions/_shared/identity.test.ts
import {
  type ExistingEntity,
  type IdentityEdge,
  assignCreatorIds,
  buildIdentityComponents,
  currentIdentityValues,
  detectVidConflicts,
  edgesFromGmvRows,
  edgesFromRegistry,
  identityObservedDate,
  nodeKey,
  parseNodeKey,
} from "./identity.ts";
import {
  type StageRegistryRow,
  addDaysISO,
  buildAllStages,
  buildStagesForCreator,
  diffDays,
  eventsFromRegistryRow,
  ownerAt,
} from "./stages.ts";

function assert(cond: unknown, msg = "断言失败"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  // 键顺序不参与比较：这里比的是值，不是对象字面量的写法
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
      : v;
  const a = JSON.stringify(stable(actual));
  const e = JSON.stringify(stable(expected));
  if (a !== e) throw new Error(`${msg ? msg + "：" : ""}实际 ${a} ≠ 预期 ${e}`);
}

// ---------- 身份观察日期（测试 42） ----------

Deno.test("identityObservedDate: 文件月份的下一个月 1 日，跨年正确", () => {
  assertEquals(identityObservedDate("2026-08"), "2026-09-01");
  assertEquals(identityObservedDate("2026-12"), "2027-01-01");
  assertEquals(identityObservedDate("2026-13"), null);
  assertEquals(identityObservedDate("坏数据"), null);
});

Deno.test("测试 42：身份观察日期只进别名新鲜度，不进任何归因日期计算", () => {
  // 结构性保证：GMV 边的 observedDate 只写进别名的 first/last_seen，
  // 区间生成（stages.ts）的入参里根本没有这个字段 —— 想误用都拿不到。
  const edges = edgesFromGmvRows([{ country: "PH", vid: "V1", accountNameNorm: "王姐好物", month: "2026-08" }]);
  assertEquals(edges[0].observedDate, "2026-09-01");
  const { components } = buildIdentityComponents(edges);
  assertEquals(components[0].aliases[0].lastSeenDate, "2026-09-01");
  // StageRegistryRow 只有 sampleDate / registerDate 两个日期字段
  const row: StageRegistryRow = { country: "PH", creatorKey: "王姐好物", staff: "李汝华", sampleDate: "2026-08-20", registerDate: null };
  assertEquals(Object.keys(row).filter((k) => k.toLowerCase().includes("observ")), []);
});

// ---------- 建边与分量 ----------

Deno.test("nodeKey / parseNodeKey 往返一致，站点与类型都在键里", () => {
  const k = nodeKey("ph", "NICKNAME", "小王");
  assertEquals(parseNodeKey(k), { site: "PH", type: "NICKNAME", value: "小王" });
  assert(nodeKey("PH", "NICKNAME", "x") !== nodeKey("PH", "USERNAME", "x"));
  assert(nodeKey("PH", "NICKNAME", "x") !== nodeKey("PH2", "NICKNAME", "x"));
});

Deno.test("测试 30：同一行共现的昵称与用户名合并成一个达人（不需要 VID）", () => {
  const edges = edgesFromRegistry([
    { country: "PH", vid: "", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
  ]);
  const { components } = buildIdentityComponents(edges);
  assertEquals(components.length, 1);
  assertEquals(components[0].nodeKeys.length, 2);
});

Deno.test("测试 34：达人改名 —— GMV MAX 的新昵称经 VID 锚定并入同一实体", () => {
  const edges = [
    ...edgesFromRegistry([
      { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    ]),
    ...edgesFromGmvRows([{ country: "PH", vid: "V001", accountNameNorm: "王姐好物", month: "2026-09" }]),
  ];
  const { components, conflicts } = buildIdentityComponents(edges);
  assertEquals(conflicts.length, 0);
  assertEquals(components.length, 1);
  assertEquals(components[0].nodeKeys.length, 3); // 小王 / 王姐好物 / wang888
});

Deno.test("测试 37：字段级最新值 —— 空值不覆盖非空值", () => {
  const edges = [
    ...edgesFromRegistry([
      { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    ]),
    // GMV MAX 2026-09 这条只有昵称、没有用户名
    ...edgesFromGmvRows([{ country: "PH", vid: "V001", accountNameNorm: "王姐好物", month: "2026-09" }]),
  ];
  const { components } = buildIdentityComponents(edges);
  const cur = currentIdentityValues(components[0].aliases);
  assertEquals(cur.nickname, "王姐好物"); // 观察日 2026-10-01 > 2026-08-20
  assertEquals(cur.username, "wang888"); // 没有更新的用户名 → 保持旧值，不被空值抹掉
  // 历史别名全部保留
  assertEquals(components[0].aliases.map((a) => a.normalizedValue).sort(), ["wang888", "小王", "王姐好物"]);
});

Deno.test("测试 38：同一站点+VID 出现两个不同用户名 → 冲突，该 VID 不作锚点", () => {
  const edges = edgesFromRegistry([
    { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    { country: "PH", vid: "V001", nicknameNorm: "小李", handleNorm: "li999", registerDate: "2026-08-21", sampleDate: null, staffName: "何莎莎" },
  ]);
  const { conflicts, unusable } = detectVidConflicts(edges);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].kind, "VID_MULTI_USERNAME");
  assert(unusable.has("PH\u001fV001"));
  const { components } = buildIdentityComponents(edges);
  // 两行各自的昵称+用户名仍靠同行共现成对，但两个人没有被 VID 连到一起
  assertEquals(components.length, 2);
});

Deno.test("测试 35 / 39：一个 VID 被两个同事登记 —— 名字一致可合并，名字不一致才不合并", () => {
  // 39：昵称、用户名完全一致 → 身份可以合并（归属争议另走 VID_DUAL_SOURCE，不归这一层管）
  const same = edgesFromRegistry([
    { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-25", sampleDate: null, staffName: "何莎莎" },
  ]);
  assertEquals(detectVidConflicts(same).conflicts.length, 0);
  assertEquals(buildIdentityComponents(same).components.length, 1);
  // 35：名字对不上 → 这个 VID 整个不参与合并
  const diff = edgesFromRegistry([
    { country: "PH", vid: "V002", nicknameNorm: "小王", handleNorm: "", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    { country: "PH", vid: "V002", nicknameNorm: "小李", handleNorm: "", registerDate: "2026-08-25", sampleDate: null, staffName: "何莎莎" },
  ]);
  assertEquals(detectVidConflicts(diff).conflicts[0].kind, "VID_MULTI_NICKNAME");
  assertEquals(buildIdentityComponents(diff).components.length, 2);
});

Deno.test("测试 40：同一 VID 出现在两个站点 → 两个独立身份，不合并、不产生待判项", () => {
  const edges = edgesFromRegistry([
    { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    { country: "PH2", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
  ]);
  const { components, conflicts } = buildIdentityComponents(edges);
  assertEquals(conflicts.length, 0);
  assertEquals(components.length, 2);
  assertEquals(components.map((c) => c.site).sort(), ["PH", "PH2"]);
});

Deno.test("buildIdentityComponents: REJECTED 的边整条不参与合并", () => {
  const edges: IdentityEdge[] = [
    ...edgesFromRegistry([
      { country: "PH", vid: "V001", nicknameNorm: "小王", handleNorm: "wang888", registerDate: "2026-08-20", sampleDate: null, staffName: "李汝华" },
    ]),
    { site: "PH", vid: "V001", feishuNicknameNorm: "", feishuUsernameNorm: "", gmvNicknameNorm: "误合并的人", observedDate: "2026-09-01", source: "GMV_MAX", status: "REJECTED" },
  ];
  const { components } = buildIdentityComponents(edges);
  assertEquals(components.length, 1);
  assertEquals(components[0].nodeKeys.length, 2);
});

Deno.test("buildIdentityComponents: 结果与输入顺序无关（可确定性重算）", () => {
  const rows = [
    { country: "PH", vid: "V1", nicknameNorm: "a", handleNorm: "b", registerDate: "2026-01-01", sampleDate: null, staffName: "X" },
    { country: "PH", vid: "V1", nicknameNorm: "c", handleNorm: "b", registerDate: "2026-02-01", sampleDate: null, staffName: "X" },
    { country: "PH", vid: "V2", nicknameNorm: "d", handleNorm: "", registerDate: "2026-03-01", sampleDate: null, staffName: "X" },
  ];
  const a = buildIdentityComponents(edgesFromRegistry(rows));
  const b = buildIdentityComponents(edgesFromRegistry([...rows].reverse()));
  assertEquals(a.components.map((c) => c.signature), b.components.map((c) => c.signature));
  assertEquals(a.components.map((c) => c.nodeKeys), b.components.map((c) => c.nodeKeys));
});

// ---------- creator_id 分配 ----------

const comp = (site: string, names: Array<[string, "NICKNAME" | "USERNAME"]>) => {
  const nodeKeys = names.map(([v, t]) => nodeKey(site, t, v)).sort();
  return { site, signature: nodeKeys[0], nodeKeys, aliases: [] };
};

Deno.test("assignCreatorIds: 认不到已有实体 → 新建；认到一个 → 复用并更新签名", () => {
  const c = comp("PH", [["小王", "NICKNAME"], ["wang888", "USERNAME"]]);
  const fresh = assignCreatorIds([c], []);
  assertEquals(fresh.inserts, [{ site: "PH", signature: c.signature }]);
  assertEquals(fresh.bySignature.size, 0);

  // 旧实体的签名是「小王」，新分量的签名是字典序更小的「wang888」→ 复用 ID 并更新签名
  const existing: ExistingEntity[] = [
    { creatorId: "id-1", site: "PH", signature: nodeKey("PH", "NICKNAME", "小王"), createdAt: "2026-01-01T00:00:00Z", mergedInto: null },
  ];
  const reused = assignCreatorIds([c], existing);
  assertEquals(reused.inserts.length, 0);
  assertEquals(reused.bySignature.get(c.signature), "id-1");
  assertEquals(reused.signatureUpdates, [{ creatorId: "id-1", signature: c.signature }]);
  assert(c.signature === nodeKey("PH", "USERNAME", "wang888"), "签名 = 分量内字典序最小的节点键");
});

Deno.test("assignCreatorIds: 两个旧实体被新证据连成一个人 → 保留创建更早的一方", () => {
  const c = comp("PH", [["小王", "NICKNAME"], ["王姐好物", "NICKNAME"]]);
  const existing: ExistingEntity[] = [
    { creatorId: "id-new", site: "PH", signature: nodeKey("PH", "NICKNAME", "王姐好物"), createdAt: "2026-05-01T00:00:00Z", mergedInto: null },
    { creatorId: "id-old", site: "PH", signature: nodeKey("PH", "NICKNAME", "小王"), createdAt: "2026-01-01T00:00:00Z", mergedInto: null },
  ];
  const r = assignCreatorIds([c], existing);
  assertEquals(r.bySignature.get(c.signature), "id-old");
  assertEquals(r.merges, [{ creatorId: "id-new", mergedInto: "id-old" }]);
});

Deno.test("测试 41：否决错误合并后分量拆开，存活方的 creator_id 不变", () => {
  const kept = comp("PH", [["小王", "NICKNAME"], ["wang888", "USERNAME"]]);
  const split = comp("PH", [["误合并的人", "NICKNAME"]]);
  const existing: ExistingEntity[] = [
    { creatorId: "id-1", site: "PH", signature: kept.signature, createdAt: "2026-01-01T00:00:00Z", mergedInto: null },
  ];
  const r = assignCreatorIds([kept, split], existing);
  assertEquals(r.bySignature.get(kept.signature), "id-1"); // 存活方 ID 不变
  assertEquals(r.inserts, [{ site: "PH", signature: split.signature }]); // 拆出来的一半拿新 ID
  assertEquals(r.merges.length, 0);
});

Deno.test("assignCreatorIds: 已被合并掉的实体不再参与认亲", () => {
  const c = comp("PH", [["小王", "NICKNAME"]]);
  const existing: ExistingEntity[] = [
    { creatorId: "id-dead", site: "PH", signature: nodeKey("PH", "NICKNAME", "小王"), createdAt: "2026-01-01T00:00:00Z", mergedInto: "id-1" },
  ];
  assertEquals(assignCreatorIds([c], existing).inserts.length, 1);
});

// ---------- 区间生成 ----------

const REG = (staff: string, sample: string | null, register: string | null): StageRegistryRow => ({
  country: "PH",
  creatorKey: "王姐好物",
  staff,
  sampleDate: sample,
  registerDate: register,
});

Deno.test("addDaysISO / diffDays: 按自然天，跨月跨年正确", () => {
  assertEquals(addDaysISO("2026-01-10", 90), "2026-04-10");
  assertEquals(diffDays("2026-01-10", "2026-04-10"), 90);
  assertEquals(diffDays("2026-02-01", "2026-03-01"), 28); // 2026 非闰年
  assertEquals(addDaysISO("2026-12-31", 1), "2027-01-01");
});

Deno.test("测试 36：一行同时有发样日和回收日 → 两条动作事件", () => {
  const evs = eventsFromRegistryRow(REG("李汝华", "2026-01-10", "2026-02-20"));
  assertEquals(evs.map((e) => [e.kind, e.date]), [["SAMPLE", "2026-01-10"], ["RECLAIM", "2026-02-20"]]);
  // 首次建联日取较早者（发样），最近有效动作日取较晚者（回收）
  const { stages } = buildStagesForCreator("PH", "王姐好物", [REG("李汝华", "2026-01-10", "2026-02-20")]);
  assertEquals(stages.length, 1);
  assertEquals(stages[0].startDate, "2026-01-10");
  // 现有实现 `register_date ?? sample_date` 会把起点算成 2026-02-20，这正是「事实 1」要修的
});

Deno.test("区间：同 BD 多次动作不开新区间，只刷新最近动作日", () => {
  const { stages } = buildStagesForCreator("PH", "王姐好物", [
    REG("李汝华", "2026-01-10", null),
    REG("李汝华", null, "2026-03-01"),
  ]);
  assertEquals(stages.length, 1);
  assertEquals([stages[0].staffName, stages[0].startDate, stages[0].endDate], ["李汝华", "2026-01-10", null]);
});

Deno.test("区间：异 BD 满 90 自然天 → 开新区间；差一天 → 抢注无效", () => {
  const ok = buildStagesForCreator("PH", "王姐好物", [REG("李汝华", null, "2026-01-10"), REG("何莎莎", null, "2026-04-10")]);
  assertEquals(ok.stages.map((s) => [s.staffName, s.startDate, s.endDate, s.stageType]), [
    ["李汝华", "2026-01-10", "2026-04-10", "FIRST_CONTACT"],
    ["何莎莎", "2026-04-10", null, "AUTO_90D"],
  ]);
  assertEquals(ok.grabs.length, 0);

  const grab = buildStagesForCreator("PH", "王姐好物", [REG("李汝华", null, "2026-01-10"), REG("何莎莎", null, "2026-04-09")]);
  assertEquals(grab.stages.length, 1);
  assertEquals(grab.stages[0].staffName, "李汝华");
  assertEquals(grab.grabs.length, 1);
  assertEquals(grab.grabs[0].grabBy, "何莎莎");
  // 抢注是规则能判的：归原 BD + 留审查记录，不挂起 GMV（§十一）
});

Deno.test("区间：90 天从「最近一次有效动作」起算，不是从首次建联起算", () => {
  const { stages } = buildStagesForCreator("PH", "王姐好物", [
    REG("李汝华", "2026-01-10", null),
    REG("李汝华", null, "2026-03-01"), // 刷新最近动作日
    REG("何莎莎", null, "2026-04-15"), // 距 03-01 只有 45 天 → 抢注
  ]);
  assertEquals(stages.length, 1);
  assertEquals(stages[0].staffName, "李汝华");
});

Deno.test("区间：交接优先于 90 天规则，转移日 = 新 BD 交接后首次动作", () => {
  const { stages } = buildStagesForCreator(
    "PH",
    "王姐好物",
    [REG("阿木", null, "2026-06-01"), REG("李汝华", null, "2026-07-20")],
    [{ fromBd: "阿木", toBd: "李汝华", date: "2026-07-01" }],
  );
  // 7-20 距 6-01 只有 49 天，光靠 90 天规则不会转移；交接让它转了
  assertEquals(stages.map((s) => [s.staffName, s.startDate, s.stageType]), [
    ["阿木", "2026-06-01", "FIRST_CONTACT"],
    ["李汝华", "2026-07-20", "HANDOVER"],
  ]);
});

Deno.test("区间：新 BD 从未对该达人动过手 → 这次交接对他永不生效", () => {
  const { stages } = buildStagesForCreator(
    "PH",
    "王姐好物",
    [REG("阿木", null, "2026-06-01")],
    [{ fromBd: "阿木", toBd: "李汝华", date: "2026-07-01" }],
  );
  assertEquals(stages.length, 1);
  assertEquals(stages[0].staffName, "阿木");
});

Deno.test("区间：人工判定建立一个阶段，之后的交接照样能终止它（不是永久豁免）", () => {
  const { stages } = buildStagesForCreator(
    "PH",
    "王姐好物",
    [REG("阿木", null, "2026-01-10"), REG("李汝华", null, "2026-07-20")],
    [{ fromBd: "何莎莎", toBd: "李汝华", date: "2026-07-01" }],
    [{ decision: "ASSIGN", staffName: "何莎莎", effectiveFrom: "2026-03-01", effectiveTo: null }],
  );
  assertEquals(stages.map((s) => [s.staffName, s.startDate, s.stageType]), [
    ["阿木", "2026-01-10", "FIRST_CONTACT"],
    ["何莎莎", "2026-03-01", "MANUAL"],
    ["李汝华", "2026-07-20", "HANDOVER"],
  ]);
});

Deno.test("区间：同日交接与人工判定同时存在 → 交接优先", () => {
  const { stages } = buildStagesForCreator(
    "PH",
    "王姐好物",
    [REG("阿木", null, "2026-01-10"), REG("李汝华", null, "2026-07-01"), REG("何莎莎", null, "2026-12-01")],
    [{ fromBd: "阿木", toBd: "李汝华", date: "2026-07-01" }],
    [{ decision: "ASSIGN", staffName: "何莎莎", effectiveFrom: "2026-07-01", effectiveTo: null }],
  );
  const at = stages.find((s) => s.startDate === "2026-07-01");
  assertEquals(at?.staffName, "李汝华");
  assertEquals(at?.stageType, "HANDOVER");
});

Deno.test("区间：区间之间首尾相接、不重叠（数据库排他约束的前置保证）", () => {
  const { stages } = buildStagesForCreator("PH", "王姐好物", [
    REG("李汝华", null, "2026-01-10"),
    REG("何莎莎", null, "2026-04-10"),
    REG("阿木", null, "2026-09-10"),
  ]);
  assertEquals(stages.length, 3);
  for (let i = 1; i < stages.length; i++) assertEquals(stages[i - 1].endDate, stages[i].startDate);
  assertEquals(stages[stages.length - 1].endDate, null);
});

Deno.test("ownerAt: 按发布日期命中区间 —— 历史月份不被今天的归属改判", () => {
  const { stages } = buildStagesForCreator("PH", "王姐好物", [
    REG("李汝华", null, "2026-01-10"),
    REG("何莎莎", null, "2026-04-10"),
  ]);
  assertEquals(ownerAt(stages, "2026-02-01")?.staffName, "李汝华");
  assertEquals(ownerAt(stages, "2026-04-09")?.staffName, "李汝华");
  assertEquals(ownerAt(stages, "2026-04-10")?.staffName, "何莎莎"); // 半开区间 [start, end)
  assertEquals(ownerAt(stages, "2026-08-01")?.staffName, "何莎莎");
  assertEquals(ownerAt(stages, "2025-12-31"), null); // 首次建联之前没有任何归属
});

Deno.test("buildAllStages: 按 (站点, 达人) 分组，站点不同即不同的人", () => {
  const { stages } = buildAllStages({
    rows: [
      { country: "PH", creatorKey: "王姐好物", staff: "李汝华", sampleDate: null, registerDate: "2026-01-10" },
      { country: "PH2", creatorKey: "王姐好物", staff: "何莎莎", sampleDate: null, registerDate: "2026-01-10" },
    ],
    handoversByCountry: new Map(),
    manualByCreator: new Map(),
  });
  assertEquals(stages.length, 2);
  assertEquals(stages.map((s) => [s.country, s.staffName]).sort(), [["PH", "李汝华"], ["PH2", "何莎莎"]]);
});
