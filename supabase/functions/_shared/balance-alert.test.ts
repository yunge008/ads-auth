// 跑法：deno test supabase/functions/_shared/balance-alert.test.ts（bun test 也能跑）
import {
  classifySwitch,
  computeSpendStats,
  dayLevel,
  daysLeft,
  mergeDailySpend,
  overallLevel,
  pickAvailableBalance,
  shouldAlert,
  siteOf,
  spendWindow,
  switchDayN,
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

// ---------- 换户（2026-11-25） ----------
const dl = (xs: number[]) => xs.map((spend, i) => ({ date: dates[i], spend }));

Deno.test("switch: new account starts on last day, old has no permission (PH 11-24 case)", () => {
  const r = classifySwitch([
    { id: "old", site: "PH", daily: null },
    { id: "new", site: "PH", daily: dl([0, 0, 0, 0, 0, 0, 0, 0, 0, 640.54]) },
  ]);
  eq(r.get("new"), { role: "current", site: "PH", switch_date: dates[9], replaced_by: null });
  eq(r.get("old"), { role: "switched_out", site: "PH", switch_date: dates[9], replaced_by: "new" });
});

Deno.test("switch: old still readable, spent until switch day (same-day overlap ok)", () => {
  const r = classifySwitch([
    { id: "old", site: "TH", daily: dl([600, 600, 600, 600, 600, 300, 0, 0, 0, 0]) },
    { id: "new", site: "TH", daily: dl([0, 0, 0, 0, 0, 200, 600, 600, 600, 600]) },
  ]);
  eq([r.get("new")!.role, r.get("new")!.switch_date, r.get("old")!.role], ["current", dates[5], "switched_out"]);
});

Deno.test("no switch: running all window -> other zero-spend account is idle", () => {
  const r = classifySwitch([
    { id: "run", site: "JP", daily: dl([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) },
    { id: "staged", site: "JP", daily: dl([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
  ]);
  eq([r.get("run")!.role, r.get("staged")!.role, r.get("staged")!.switch_date], ["normal", "idle", null]);
});

Deno.test("old account spends again after switch -> not classified", () => {
  const r = classifySwitch([
    { id: "old", site: "MY", daily: dl([5, 5, 5, 0, 0, 0, 0, 0, 3, 0]) },
    { id: "new", site: "MY", daily: dl([0, 0, 0, 0, 5, 5, 5, 5, 5, 5]) },
  ]);
  eq([r.get("old")!.role, r.get("new")!.role], ["normal", "normal"]);
});

Deno.test("single account in site / no site / no spend -> normal", () => {
  const r = classifySwitch([
    { id: "a", site: "VN", daily: dl([0, 0, 0, 0, 0, 0, 0, 0, 0, 9]) },
    { id: "b", site: null, daily: null },
    { id: "c", site: "SG", daily: dl([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    { id: "d", site: "SG", daily: null },
  ]);
  eq(["a", "b", "c", "d"].map((k) => r.get(k)!.role), ["normal", "normal", "normal", "normal"]);
});

Deno.test("switch day excluded from average; only full days after it count", () => {
  const s = computeSpendStats(dates, m([0, 0, 0, 0, 0, 0, 300, 900, 1000, 950]), 0.3, dates[6]);
  eq(s.valid_days, 3);
  near(s.avg_daily_spend, 950);
  eq(s.days[6].valid, false);
  // 换户日是昨天 → 一个整天都没有 → 日均 null，不预警
  const s2 = computeSpendStats(dates, m([0, 0, 0, 0, 0, 0, 0, 0, 0, 640]), 0.3, dates[9]);
  eq([s2.valid_days, s2.avg_daily_spend], [0, null]);
});

Deno.test("switch day N: switch day = 1, today = N", () => {
  eq(switchDayN("2026-11-24", "2026-11-24"), 2);
  eq(switchDayN("2026-11-16", "2026-11-24"), 10);
});

Deno.test("site from country, else from account name suffix (longest match)", () => {
  const known = ["PH", "PH2", "MX-AR", "AR", "TH"];
  eq(siteOf("TH", "x", known), "TH");
  eq(siteOf(null, "ECO9B-有只鲸-PH2", known), "PH2");
  eq(siteOf(null, "ECO9-有只鲸-MX-AR", known), "MX-AR");
  eq(siteOf(null, "ECO9-有只鲸-暂无用", known), null);
});
