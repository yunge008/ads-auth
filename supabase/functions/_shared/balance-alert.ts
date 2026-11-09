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
