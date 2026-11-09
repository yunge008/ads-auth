// 账户余额预警：纯函数（无 IO），便于单测。
//
// 口径（2026-11-09 定）：
// - 计量窗口 = 最近 WINDOW_DAYS(10) 个**完整自然日**（北京日期，昨天往前数 10 天，不含今天这种未结束的日）。
// - 某天日耗 = max(BASIC 报表 spend, GMV Max 报表 cost)。两个报表是否互相包含官方未写清，
//   取 max 可以同时兼容「BASIC 已含 GMV Max」和「BASIC 不含 GMV Max（纯 GMV Max 户 BASIC≈0）」两种情况，
//   代价是「同一天既跑常规广告又跑 GMV Max 且 BASIC 不含 GMV Max」时会低估。
// - 异常日剔除：日耗 ≤ 0 的天直接剔除；其余天里，低于「正日耗中位数 × abnormalRatio」的天视为
//   没开 / 学习期 / 停投半天，剔除。剩下的「正常天」求平均 = 正常日均。
// - 可用天数 = 可用余额 / 正常日均；正常日均不存在（窗口内一天正常都没有）→ null，不参与预警。

export const WINDOW_DAYS = 10;
export const DEFAULT_ABNORMAL_RATIO = 0.3;

export type DaySpend = { date: string; spend: number };

export type SpendStats = {
  window_days: number;
  /** 窗口内每天日耗（含被剔除的天），按日期升序 */
  days: Array<DaySpend & { valid: boolean }>;
  /** 正日耗中位数（剔除判断的基准） */
  median: number | null;
  /** 低于此值的天被剔除 */
  threshold: number | null;
  valid_days: number;
  avg_daily_spend: number | null;
};

/** 北京日期 YYYY-MM-DD，offsetDays 相对今天 */
export function beijingDate(offsetDays = 0, now = Date.now()): string {
  const d = new Date(now + 8 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** 窗口：[昨天-(n-1), 昨天] */
export function spendWindow(now = Date.now(), n = WINDOW_DAYS): { start: string; end: string; dates: string[] } {
  const dates: string[] = [];
  for (let i = n; i >= 1; i--) dates.push(beijingDate(-i, now));
  return { start: dates[0], end: dates[dates.length - 1], dates };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param dates 窗口内全部日期（报表里没有的天按 0 计）
 * @param spendByDate 日期 → 当天日耗
 */
export function computeSpendStats(
  dates: string[],
  spendByDate: Map<string, number>,
  abnormalRatio = DEFAULT_ABNORMAL_RATIO,
): SpendStats {
  const raw = dates.map((date) => ({ date, spend: Math.max(0, Number(spendByDate.get(date) ?? 0) || 0) }));
  const positives = raw.filter((d) => d.spend > 0).map((d) => d.spend);
  const med = median(positives);
  const threshold = med == null ? null : med * abnormalRatio;
  const days = raw.map((d) => ({ ...d, valid: d.spend > 0 && threshold != null && d.spend >= threshold }));
  const valid = days.filter((d) => d.valid);
  const avg = valid.length ? valid.reduce((s, d) => s + d.spend, 0) / valid.length : null;
  return {
    window_days: dates.length,
    days,
    median: med,
    threshold,
    valid_days: valid.length,
    avg_daily_spend: avg,
  };
}

/** 可用天数；日均不存在或 ≤0 → null。余额 ≤0 → 0。 */
export function daysLeft(balance: number | null, avg: number | null): number | null {
  if (balance == null || avg == null || !(avg > 0)) return null;
  if (balance <= 0) return 0;
  return balance / avg;
}

/** 是否触发预警：开关开 + 可用天数可算 + 可用天数 < X */
export function shouldAlert(enabled: boolean, days: number | null, thresholdDays: number): boolean {
  return enabled && days != null && days < thresholdDays;
}

/** 两路日耗合并：同一天取 max（理由见文件头） */
export function mergeDailySpend(...sources: Array<Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const src of sources) {
    for (const [d, v] of src) out.set(d, Math.max(out.get(d) ?? 0, Number(v) || 0));
  }
  return out;
}

// ---------- 可用余额取值（2026-11-09 第二版） ----------
// 实测：代理商信用额度户（ROLE_CHILD_ADVERTISER，月结、「可用信用额度：余额充足」）现金余额恒为 0，
// 真正能花的上限是 BC 给该户设的「预算」剩余（TikTok 后台 付款 → 预算 → 剩余预算，与 ECO 后台「可用余额」一致）。
// 规则：
//   预算剩余 = budget_remaining，没有则 budget - budget_cost；预算模式含 DAY（日预算，每天重置）时不用。
//   现金 = valid_account_balance，没有则 account_balance。
//   有预算剩余且现金 > 0 → 取两者较小（两者都会卡住投放）；
//   只有预算剩余 → 预算剩余；
//   现金 > 0 → 现金；
//   现金 = 0 且没设预算 → null（分不清是「信用户无上限」还是真没钱，宁可不报，记原因）；
//   BC 没返回该户 → info.balance > 0 才用，否则 null。
export type BalanceInputs = {
  bcListed: boolean;
  valid: number | null;
  total: number | null;
  budgetMode: string | null;
  budget: number | null;
  budgetCost: number | null;
  budgetRemaining: number | null;
  infoBalance: number | null;
};

export function pickAvailableBalance(x: BalanceInputs): { balance: number | null; verdict: string } {
  let budgetRem = x.budgetRemaining ?? (x.budget != null && x.budget > 0 && x.budgetCost != null ? x.budget - x.budgetCost : null);
  if (budgetRem != null && /DAY/i.test(x.budgetMode ?? "")) budgetRem = null;
  if (budgetRem != null && x.budget != null && x.budget <= 0 && x.budgetRemaining == null) budgetRem = null;
  if (x.bcListed) {
    const cash = x.valid ?? x.total;
    if (budgetRem != null && cash != null && cash > 0) {
      return { balance: Math.min(cash, budgetRem), verdict: "预算剩余与现金余额取较小" };
    }
    if (budgetRem != null) return { balance: budgetRem, verdict: "采用预算剩余（信用额度户）" };
    if (cash != null && cash > 0) return { balance: cash, verdict: "采用现金可用余额" };
    return { balance: null, verdict: "现金余额为 0 且未设预算，无法判断可花额度，不参与预警" };
  }
  if (x.infoBalance != null && x.infoBalance > 0) return { balance: x.infoBalance, verdict: "BC 未列出，采用 info.balance" };
  return { balance: null, verdict: "BC 未列出且 info.balance 为 0/空，未取到可信余额，不参与预警" };
}

// ---------- 颜色分级（2026-11-09） ----------
// 单户：可用天数 < X → red（已达监控天数）；X ≤ 可用天数 < X+5 → yellow（距离监控天数 5 天内）；其余 green；算不出 → none
// 整体（飞书卡片头）：有户可用天数 ≤ 0（用光）→ red；有户 < X（预警）→ yellow；否则 green
export const NEAR_DAYS = 5;
export type Level = "red" | "yellow" | "green" | "none";

export function dayLevel(days: number | null, X: number): Level {
  if (days == null) return "none";
  if (days < X) return "red";
  if (days < X + NEAR_DAYS) return "yellow";
  return "green";
}

export function overallLevel(daysList: Array<number | null>, X: number): "red" | "yellow" | "green" {
  if (daysList.some((d) => d != null && d <= 0)) return "red";
  if (daysList.some((d) => d != null && d < X)) return "yellow";
  return "green";
}
