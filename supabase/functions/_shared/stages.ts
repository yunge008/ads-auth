// 达人「新素材」归属区间生成（纯函数，无 IO）。见 GMV_ATTRIBUTION_V3_PLAN §四/§五。
//
// 与现有 resolveOwnership 的三点关键差异（阶段 2「只生成不使用」，阶段 3 才切引擎）：
//
// 1. **一条登记行展开成最多两条动作事件**（计划「事实 1」）。
//    现有代码 `const date = r.register_date ?? r.sample_date` 一行只取一个日期：
//    同时有发样日和回收日时发样日被整个丢掉，而且这唯一的日期同时当「首次建联日」和
//    「最近有效动作日」两用。后果是首次建联日偏晚、极少数行最近动作日偏早。
//    这里把发样(SAMPLE)/回收素材(RECLAIM)展开成同一条时间线上的两个事件：
//    firstDate = min(所有事件)，ownerLast = max(当前 owner 的所有事件)。
//
// 2. **保护期 = 90 自然天**，窗口 `[D-90, D)`，与线上引擎同口径
//    （2026-09-16 起两边都改成 90 天，常量与日期工具共用 attribution.ts 的同一份实现）。
//
// 3. **产出是区间而不是单值**。现有 creator_ownership 只有「当前 owner」一个值，
//    历史月份的 GMV 会被今天的归属改判；区间按发布日期命中，历史数字才稳定。
//
// 事件优先级（同一天多个事件时）：正式交接 > 人工达人判定 > 90 天规则自动切换。

import { PROTECTION_DAYS, addDaysISO, diffDays } from "./attribution.ts";

export type ActionKind = "SAMPLE" | "RECLAIM";

/** 一次有效动作：谁、在哪天、对哪个达人做了什么。 */
export type ActionEvent = { staff: string; date: string; kind: ActionKind; sheet?: string; rowNumber?: number | null };

export type StageRegistryRow = {
  country: string;
  creatorKey: string;
  staff: string;
  sampleDate: string | null;
  registerDate: string | null;
  sheet?: string;
  rowNumber?: number | null;
};

export type StageHandover = { fromBd: string; toBd: string; date: string };

export type StageManualDecision = {
  decision: "ASSIGN" | "EXCLUDE";
  staffName: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type Stage = {
  country: string;
  creatorKey: string;
  staffName: string;
  stageType: "FIRST_CONTACT" | "HANDOVER" | "MANUAL" | "AUTO_90D";
  startDate: string;
  endDate: string | null;
  evidence: unknown;
};

export type StageGrab = { country: string; creatorKey: string; owner: string; grabBy: string; date: string; ownerLastDate: string };

export type StageBuild = { stages: Stage[]; grabs: StageGrab[] };

// 保护期天数与日期工具**只有一份实现**，在 attribution.ts 里 —— 区间层与线上引擎
// 必须永远同口径，各写一套迟早会漂。这里原样再导出，方便本模块的调用方直接用。
export { PROTECTION_DAYS, addDaysISO, diffDays };

/**
 * 登记行 → 动作事件。**一行最多两条**：发样日一条、回收素材日一条。
 * 「回收素材日期」= 建联表的「登记日期」列（register_date），不是发样日、也不是素材发布日。
 */
export function eventsFromRegistryRow(r: StageRegistryRow): ActionEvent[] {
  const out: ActionEvent[] = [];
  if (r.sampleDate) out.push({ staff: r.staff, date: r.sampleDate, kind: "SAMPLE", sheet: r.sheet, rowNumber: r.rowNumber });
  if (r.registerDate) out.push({ staff: r.staff, date: r.registerDate, kind: "RECLAIM", sheet: r.sheet, rowNumber: r.rowNumber });
  return out;
}

/** 事件排序：日期升序；同日先 SAMPLE 后 RECLAIM；再按同事名，保证重算结果确定。 */
function sortEvents(events: ActionEvent[]): ActionEvent[] {
  return [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "SAMPLE" ? -1 : 1;
    return a.staff < b.staff ? -1 : a.staff > b.staff ? 1 : 0;
  });
}

/**
 * 生成一个达人的归属区间。
 *
 * · owner = 最早有动作的 BD，区间从他的首次动作日开始（FIRST_CONTACT）；
 * · 同 BD 再动作 → 刷新 ownerLast，不开新区间；
 * · 异 BD 动作且距 ownerLast ≥ 90 自然天 → 从该日起开新区间（AUTO_90D）；
 * · 异 BD 动作在保护期内 → **抢注无效**，归属不变，记一条审查项（规则能判，不挂起 GMV）；
 * · 交接：交接日之后新 BD 对**这个达人**首次动作那天起开新区间（HANDOVER），
 *   优先级高于 90 天规则 —— 交接来的达人不需要再等保护期；
 * · 人工判定 ASSIGN：从 effective_from 起开新区间（MANUAL）。它是「建立一个阶段」，
 *   不是永久豁免，后面的交接/合格动作照样可以终止它（§八）。
 */
export function buildStagesForCreator(
  country: string,
  creatorKey: string,
  rows: StageRegistryRow[],
  handovers: StageHandover[] = [],
  manual: StageManualDecision[] = [],
  protectionDays = PROTECTION_DAYS,
): StageBuild {
  const events = sortEvents(rows.flatMap(eventsFromRegistryRow));
  const stages: Stage[] = [];
  const grabs: StageGrab[] = [];
  if (!events.length && !manual.length) return { stages, grabs };

  /** 某个同事在 from（含）之后对这个达人的首次动作日 */
  const firstActionOnOrAfter = (staff: string, from: string): string | null => {
    for (const e of events) if (e.staff === staff && e.date >= from) return e.date;
    return null;
  };

  // 交接 → 实际转移事件（新 BD 从未接手这个达人 → 这次交接对该达人永不生效）
  type Transfer = { date: string; staff: string; type: Stage["stageType"]; from?: string; evidence: unknown };
  const forced: Transfer[] = [];
  for (const h of [...handovers].sort((a, b) => a.date.localeCompare(b.date))) {
    const t = firstActionOnOrAfter(h.toBd, h.date);
    if (!t) continue;
    forced.push({ date: t, staff: h.toBd, type: "HANDOVER", from: h.fromBd, evidence: { handoverDate: h.date, transferDate: t } });
  }
  for (const m of manual) {
    if (m.decision !== "ASSIGN" || !m.staffName) continue;
    forced.push({ date: m.effectiveFrom, staff: m.staffName, type: "MANUAL", evidence: { manual: m } });
  }
  // 同日优先级：交接 > 人工判定
  forced.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.type === "HANDOVER" ? -1 : 1));

  let owner = "";
  let ownerLast = "";
  let stageStart = "";
  let stageType: Stage["stageType"] = "FIRST_CONTACT";
  let stageEvidence: unknown = null;
  let fi = 0;

  const openStage = (staff: string, date: string, type: Stage["stageType"], evidence: unknown) => {
    if (owner) stages.push({ country, creatorKey, staffName: owner, stageType, startDate: stageStart, endDate: date, evidence: stageEvidence });
    owner = staff;
    stageStart = date;
    stageType = type;
    stageEvidence = evidence;
    ownerLast = date;
  };

  /** 把发生在 upto（含）之前的交接/人工事件先应用掉 */
  const applyForcedUpTo = (upto: string) => {
    while (fi < forced.length && forced[fi].date <= upto) {
      const f = forced[fi++];
      // 交接只在当前 owner 正是原 BD 时生效；人工判定无条件生效
      if (f.type === "HANDOVER" && f.from && owner !== f.from) continue;
      if (!owner) continue; // 还没有任何归属 → 等首次动作先建立
      if (owner === f.staff) {
        if (f.date > ownerLast) ownerLast = f.date;
        continue;
      }
      openStage(f.staff, f.date, f.type, f.evidence);
    }
  };

  for (const e of events) {
    if (!owner) {
      owner = e.staff;
      stageStart = e.date;
      ownerLast = e.date;
      stageType = "FIRST_CONTACT";
      stageEvidence = { firstAction: e };
      continue;
    }
    applyForcedUpTo(e.date);
    if (e.staff === owner) {
      if (e.date > ownerLast) ownerLast = e.date;
      continue;
    }
    // 保护期窗口 [ownerLast, ownerLast+90)：落在窗口里 = 抢注无效
    if (diffDays(ownerLast, e.date) >= protectionDays) {
      openStage(e.staff, e.date, "AUTO_90D", { previousOwner: owner, ownerLastDate: ownerLast, trigger: e });
    } else {
      grabs.push({ country, creatorKey, owner, grabBy: e.staff, date: e.date, ownerLastDate: ownerLast });
    }
  }
  // 最后一次动作之后才发生的交接/人工判定
  applyForcedUpTo("9999-12-31");

  if (owner) stages.push({ country, creatorKey, staffName: owner, stageType, startDate: stageStart, endDate: null, evidence: stageEvidence });
  return { stages, grabs };
}

export type StageBuildInput = {
  rows: StageRegistryRow[];
  handoversByCountry: Map<string, StageHandover[]>;
  manualByCreator: Map<string, StageManualDecision[]>; // key: `${country}\u001f${creatorKey}`
  protectionDays?: number;
};

/** 全量生成：按 (站点, 达人) 分组逐个生成区间。 */
export function buildAllStages(input: StageBuildInput): StageBuild {
  const groups = new Map<string, StageRegistryRow[]>();
  for (const r of input.rows) {
    if (!r.creatorKey || !r.staff) continue;
    const k = `${r.country}\u001f${r.creatorKey}`;
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  const stages: Stage[] = [];
  const grabs: StageGrab[] = [];
  for (const [k, rows] of groups) {
    const at = k.indexOf("\u001f");
    const country = k.slice(0, at);
    const creatorKey = k.slice(at + 1);
    const b = buildStagesForCreator(
      country,
      creatorKey,
      rows,
      input.handoversByCountry.get(country) ?? [],
      input.manualByCreator.get(k) ?? [],
      input.protectionDays,
    );
    stages.push(...b.stages);
    grabs.push(...b.grabs);
  }
  return { stages, grabs };
}

/** 按发布日期命中区间 → 该日期的归属 BD；没有任何区间命中返回 null。 */
export function ownerAt(stages: Stage[], date: string): Stage | null {
  for (const s of stages) {
    if (date < s.startDate) continue;
    if (s.endDate && date >= s.endDate) continue;
    return s;
  }
  return null;
}
