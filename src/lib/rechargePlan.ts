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
//
// 变更（2026-11-16）：
// - 计划金额允许负数（= 从该户转出/少充），充值后可用天数 = max(0, 余额 + 金额) ÷ 日均。
// - T 未填但有改写值（如点了「内部平衡」）时，同样按改写值算充值后天数。
// - 内部平衡 balanceInternal：同币种的合格户放进一个池子（Σ余额 + Σ当前计划金额，
//   池子总额不变 → 纯内部调拨；若已按 T 推荐充值则一并重新分配），
//   目标天数 = D + 缓冲天数_i，缓冲_i = B × (1 − 日均_i / 组内最大日均)，
//   日耗小的户多留最多 B 天防波动；D 由 Σ日均_i×(D+缓冲_i) = 池子 解出。
//   每户净额（目标余额 − 当前余额）按 50 取整：先向下取整，再按余数从大到小补 50，
//   保证 Σ净额 = Σ原计划金额（四舍五入到 50）；任何户调后余额不为负。

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
  const hasOv = override != null && Number.isFinite(override);
  if (!eligible || (T == null && !hasOv)) {
    return { id: a.id, eligible, gap: 0, recommended: 0, recharge: 0, days: a.daysLeft };
  }
  const gap = T == null ? 0 : Math.max(0, a.avg! * T - a.balance!);
  const recommended = roundUp100(gap);
  const recharge = hasOv ? override! : recommended;
  return {
    id: a.id,
    eligible,
    gap,
    recommended,
    recharge,
    days: Math.max(0, a.balance! + recharge) / a.avg!,
  };
}

export const BALANCE_STEP = 50;
export const BALANCE_BUFFER_DAYS = 3;

/** 内部平衡：返回 每户新的计划净额（正=转入/充值，负=转出），只含参与平衡的户。 */
export function balanceInternal(
  inputs: (PlanInput & { currency?: string | null })[],
  rows: Map<string, PlanRow>,
  step = BALANCE_STEP,
  bufferDays = BALANCE_BUFFER_DAYS,
): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, typeof inputs>();
  for (const a of inputs) {
    if (!(a.enabled && a.balance != null && a.avg != null && a.avg > 0)) continue;
    const k = a.currency ?? "";
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const cur = g.map((a) => rows.get(a.id)?.recharge ?? 0);
    const S = cur.reduce((s, x) => s + x, 0);
    const pool = g.reduce((s, a, i) => s + a.balance! + cur[i], 0);
    if (!(pool > 0)) continue;
    const sumAvg = g.reduce((s, a) => s + a.avg!, 0);
    const maxAvg = Math.max(...g.map((a) => a.avg!));
    let buf = g.map((a) => bufferDays * (1 - a.avg! / maxAvg));
    let D = (pool - g.reduce((s, a, i) => s + a.avg! * buf[i], 0)) / sumAvg;
    if (D < 0) {
      // 池子不够给缓冲：退化为同天数
      buf = buf.map(() => 0);
      D = pool / sumAvg;
    }
    const exact = g.map((a, i) => a.avg! * (D + buf[i]) - a.balance!);
    // 下限：调后余额不为负（转出不超过余额，按 step 向上取整）
    const lo = g.map((a) => Math.ceil(-a.balance! / step) * step);
    const net = exact.map((x, i) => Math.max(lo[i], Math.floor(x / step) * step));
    let units = Math.round((Math.round(S / step) * step - net.reduce((s, x) => s + x, 0)) / step);
    const byRem = g.map((_, i) => i).sort((i, j) => exact[j] - net[j] - (exact[i] - net[i]));
    for (let k = 0; units > 0 && byRem.length; k = (k + 1) % byRem.length, units--)
      net[byRem[k]] += step;
    // 下限抬高导致超额：从调后天数最多的户扣回
    while (units < 0) {
      let best = -1;
      let bestDays = -Infinity;
      g.forEach((a, i) => {
        const d = (a.balance! + net[i]) / a.avg!;
        if (net[i] - step >= lo[i] && d > bestDays) {
          bestDays = d;
          best = i;
        }
      });
      if (best < 0) break;
      net[best] -= step;
      units++;
    }
    g.forEach((a, i) => out.set(a.id, net[i]));
  }
  return out;
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
