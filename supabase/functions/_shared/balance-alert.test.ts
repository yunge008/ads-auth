// 跑法：deno test supabase/functions/_shared/balance-alert.test.ts（bun test 也能跑）
import {
  computeSpendStats,
  dayLevel,
  daysLeft,
  mergeDailySpend,
  overallLevel,
  pickAvailableBalance,
  shouldAlert,
  spendWindow,
} from "./balance-alert.ts";

function eq(a: unknown, b: unknown, msg = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb} got ${sa}`);
}
function near(a: number | null, b: number, msg = "") {
  if (a == null || Math.abs(a - b) > 1e-9) throw new Error(`${msg} expected ${b} got ${a}`);
}

const dates = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
const m = (xs: number[]) => new Map(xs.map((v, i) => [dates[i], v]));

Deno.test("window = 10 complete days ending yesterday (Beijing)", () => {
  // 2026-11-09 10:00 北京 = 02:00Z
  const w = spendWindow(Date.parse("2026-11-09T02:00:00Z"));
  eq([w.start, w.end, w.dates.length], ["2026-10-30", "2026-11-08", 10]);
  // 北京 00:30 已是新的一天（UTC 前一天 16:30）
  const w2 = spendWindow(Date.parse("2026-11-08T16:30:00Z"));
  eq(w2.end, "2026-11-08");
});

Deno.test("zero and tiny days excluded (dead account / learning phase)", () => {
  const s = computeSpendStats(dates, m([0, 0, 5, 100, 110, 90, 105, 95, 100, 0]));
  eq(s.valid_days, 6);
  near(s.avg_daily_spend, 100);
});

Deno.test("missing days count as 0 and are excluded", () => {
  const s = computeSpendStats(dates, new Map([[dates[9], 50]]));
  eq(s.valid_days, 1);
  near(s.avg_daily_spend, 50);
});

Deno.test("no spend at all -> avg null, days null, never alerts", () => {
  const s = computeSpendStats(dates, new Map());
  eq([s.valid_days, s.avg_daily_spend], [0, null]);
  eq(daysLeft(1000, s.avg_daily_spend), null);
  eq(shouldAlert(true, null, 3), false);
});

Deno.test("ramp-down is not hidden: high median keeps estimate conservative", () => {
  const s = computeSpendStats(dates, m([1000, 1000, 1000, 1000, 1000, 200, 200, 200, 200, 200]));
  // median 600 -> threshold 180 -> all valid
  eq(s.valid_days, 10);
  near(s.avg_daily_spend, 600);
});

Deno.test("days left / alert boundaries", () => {
  near(daysLeft(250, 100), 2.5);
  eq(daysLeft(-5, 100), 0);
  eq(daysLeft(null, 100), null);
  eq(shouldAlert(true, 2.99, 3), true);
  eq(shouldAlert(true, 3, 3), false);
  eq(shouldAlert(false, 0, 3), false);
});

Deno.test("merge takes max per day (avoid double count)", () => {
  const out = mergeDailySpend(new Map([["a", 10], ["b", 0]]), new Map([["a", 8], ["b", 30], ["c", 1]]));
  eq([...out.entries()], [["a", 10], ["b", 30], ["c", 1]]);
});

Deno.test("balance <= 0 but no spend in 10 days -> no alert", () => {
  const s = computeSpendStats(dates, new Map());
  eq(daysLeft(-20, s.avg_daily_spend), null);
  eq(daysLeft(0, s.avg_daily_spend), null);
  eq(shouldAlert(true, daysLeft(-20, s.avg_daily_spend), 3), false);
});

Deno.test("balance <= 0 with normal spend -> alert (0 days)", () => {
  const s = computeSpendStats(dates, m([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]));
  eq(daysLeft(0, s.avg_daily_spend), 0);
  eq(shouldAlert(true, daysLeft(0, s.avg_daily_spend), 3), true);
});

const base = { bcListed: true, valid: 0, total: 0, budgetMode: null, budget: null, budgetCost: null, budgetRemaining: null, infoBalance: 0 };

Deno.test("credit account: cash 0, budget remaining used (JP case)", () => {
  const r = pickAvailableBalance({ ...base, budget: 12508, budgetCost: 9676.38, budgetRemaining: 2831.62 });
  near(r.balance, 2831.62);
});
Deno.test("budget remaining derived from budget - cost when field missing", () => {
  const r = pickAvailableBalance({ ...base, budget: 12508, budgetCost: 9676.38 });
  near(r.balance, 12508 - 9676.38);
});
Deno.test("daily budget mode ignored", () => {
  const r = pickAvailableBalance({ ...base, valid: 500, budgetMode: "BUDGET_MODE_DAY", budget: 100, budgetRemaining: 20 });
  near(r.balance, 500);
});
Deno.test("prepay with budget cap -> min", () => {
  near(pickAvailableBalance({ ...base, valid: 300, budget: 1000, budgetRemaining: 800 }).balance, 300);
  near(pickAvailableBalance({ ...base, valid: 3000, budget: 1000, budgetRemaining: 800 }).balance, 800);
});
Deno.test("cash 0 and no budget -> null (no false alarm)", () => {
  eq(pickAvailableBalance(base).balance, null);
});
Deno.test("not listed in BC -> info balance only if > 0", () => {
  near(pickAvailableBalance({ ...base, bcListed: false, infoBalance: 17.94 }).balance, 17.94);
  eq(pickAvailableBalance({ ...base, bcListed: false, infoBalance: 0 }).balance, null);
});

Deno.test("day level: red < X, yellow < X+5, green otherwise", () => {
  eq([dayLevel(9.9, 10), dayLevel(10, 10), dayLevel(14.9, 10), dayLevel(15, 10), dayLevel(null, 10)], ["red", "yellow", "yellow", "green", "none"]);
});
Deno.test("overall level: used up red > any < X yellow > green", () => {
  eq(overallLevel([30, 0, 5], 10), "red");
  eq(overallLevel([30, 9, null], 10), "yellow");
  eq(overallLevel([30, 12, null], 10), "green");
});
