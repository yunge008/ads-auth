// 账户余额预警页的「充值计划」纯计算（只在页面算，不落库、不影响预警与飞书）。
//
// 口径（2026-11-10）：
// - 目标天数 T：希望充值后每个户还能跑 T 天（从今天起）。
// - 只对「已打开预警 且 有正常日均(>0) 且 余额可读」的户给推荐；其余户推荐列显示「—」。
// - 某户 T 天预计消耗 = 正常日均 × T；缺口 = max(0, 预计消耗 − 可用余额)。
// - 推荐充值 = 缺口按 100 向上取整（缺口 0 → 0）。用户可逐户改写，改写值优先。
// - 充值后可用天数 = (可用余额 + 计划充值) ÷ 正常日均。T 未填 → 只显示当前余额可用天数。
// - 汇总行：对「已打开预警」的户求和；可用天数(平均) 用加权口径 =
//   (Σ可用余额 + Σ计划充值) ÷ Σ日耗（只计有日耗且余额可读的户），另给简单平均供参考。

export type PlanInput = {
  id: string;
  enabled: boolean;
  balance: number | null;
  avg: number | null;
  daysLeft: number | null;
};

export type PlanRow = {
  id: string;
  eligible: boolean;
  gap: number; // 原始缺口（未取整）
  recommended: number; // 按 100 向上取整
  recharge: number; // 实际计划充值（改写值优先）
  days: number | null; // 展示用可用天数（T 未填时 = 当前可用天数）
};

export type PlanSummary = {
  balance: number;
  recharge: number;
  avg: number;
  gap: number;
  weightedDays: number | null;
  meanDays: number | null;
  count: number;
};

export function roundUp100(x: number): number {
  if (!(x > 0)) return 0;
  // 先抹掉浮点误差，避免 300.0000001 → 400
  return Math.ceil(Math.round(x * 100) / 100 / 100) * 100;
}

export function parseTargetDays(raw: string): number | null {
  const n = Number(String(raw).trim());
  return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

export function planRow(a: PlanInput, T: number | null, override?: number | null): PlanRow {
  const eligible = a.enabled && a.balance != null && a.avg != null && a.avg > 0;
  if (T == null || !eligible) {
    return { id: a.id, eligible, gap: 0, recommended: 0, recharge: 0, days: a.daysLeft };
  }
  const gap = Math.max(0, a.avg! * T - a.balance!);
  const recommended = roundUp100(gap);
  const recharge =
    override != null && Number.isFinite(override) && override >= 0 ? override : recommended;
  return { id: a.id, eligible, gap, recommended, recharge, days: (a.balance! + recharge) / a.avg! };
}

export function summarize(inputs: PlanInput[], rows: Map<string, PlanRow>): PlanSummary {
  let balance = 0,
    recharge = 0,
    avg = 0,
    gap = 0,
    wBal = 0,
    wAvg = 0,
    count = 0;
  const days: number[] = [];
  for (const a of inputs) {
    if (!a.enabled) continue;
    count++;
    const r = rows.get(a.id);
    if (a.balance != null) balance += a.balance;
    if (a.avg != null) avg += a.avg;
    if (r) {
      recharge += r.recharge;
      gap += r.gap;
    }
    if (a.balance != null && a.avg != null && a.avg > 0) {
      wBal += a.balance + (r?.recharge ?? 0);
      wAvg += a.avg;
    }
    if (r?.days != null) days.push(r.days);
  }
  return {
    balance,
    recharge,
    avg,
    gap,
    count,
    weightedDays: wAvg > 0 ? wBal / wAvg : null,
    meanDays: days.length ? days.reduce((s, d) => s + d, 0) / days.length : null,
  };
}
