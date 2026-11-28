// 跑法：deno test supabase/functions/_shared/sea-inventory.test.ts
import {
  skuCore,
  suggestWhSku,
  addDays,
  dayStartSec,
  localDay,
  parseCombo,
  salesPullStart,
  windowSold,
  allocatePool,
  applySold,
  countSold,
  DEFAULT_PARAMS,
  diffMap,
  execQty,
  largestRemainder,
  planCn,
  planOverseas,
  sortByUrgency,
  type Slot,
  type Warehouse,
} from "./sea-inventory.ts";

function eq(a: unknown, b: unknown, msg = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb} got ${sa}`);
}
const P = { ...DEFAULT_PARAMS, window_days: 10 };
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

const slot = (o: Partial<Slot>): Slot => ({
  shop_id: "PH1", region: "PH", product_id: "P1", sku_id: "S1", seller_sku: "AR140-B2", title: null,
  tts_warehouse_id: "W_PH", qty: 0, sold: 0, ...o,
});
const whPH: Warehouse = { code: "QY-PH", name: "千易 PH", kind: "overseas", status: "active", region: "PH", links: [{ shop_id: "PH1", tts_warehouse_id: "W_PH" }, { shop_id: "PH2", tts_warehouse_id: "W_PH2" }] };
const stock = (code: string, m: Record<string, number>) => new Map([[code, new Map(Object.entries(m))]]);

Deno.test("largestRemainder: 合计严格相等、按权重", () => {
  eq(largestRemainder(10, [1, 1, 1]), [4, 3, 3]);
  eq(sum(largestRemainder(97, [3, 5, 11, 0.2])), 97);
  eq(largestRemainder(5, [0, 0]), [3, 2], "权重全 0 平均分");
  eq(largestRemainder(0, [1, 2]), [0, 0]);
});

Deno.test("allocatePool: 无销量槽位先拿 zero_sale_qty，但合计不超过池子 20%", () => {
  eq(allocatePool(100, [3, 1, 0], P), [71, 24, 5]);
  // 池子 20 → 20% = 4 → 无销量只拿 4
  eq(allocatePool(20, [1, 0], P), [16, 4]);
  eq(allocatePool(0, [1, 0], P), [0, 0]);
  eq(allocatePool(9, [0, 0], P), [5, 4], "全无销量平均分");
});

Deno.test("海外仓：都健康 → 不调整", () => {
  const slots = [slot({ sku_id: "A", qty: 40, sold: 20 }), slot({ sku_id: "B", qty: 40, sold: 10 })];
  const { items, groups } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 200 }), overrides: new Map(), params: P });
  eq(items.length, 0);
  eq(groups[0].triggered, false);
});

Deno.test("海外仓：包装不同（SKU 编码不同）不合并；人工映射覆盖生效", () => {
  const slots = [
    slot({ sku_id: "A", seller_sku: "AR140-B2", qty: 1, sold: 10 }),
    slot({ sku_id: "B", seller_sku: "AR140-B4", qty: 1, sold: 10 }),
    slot({ sku_id: "C", seller_sku: "ar140-b2 ", qty: 1, sold: 10 }), // 大小写不同 → 不算同一个
  ];
  const r = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 25 }), overrides: new Map(), params: P });
  eq(r.items.map((i) => [i.sku_id, i.proposed_qty]), [["A", 20]]);
  eq(r.groups.filter((g) => g.wh_available === null).map((g) => g.wh_sku), ["AR140-B4", "ar140-b2"]);
  const r2 = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 25 }), overrides: new Map([["PH1|C", "AR140-B2"]]), params: P });
  eq(r2.items.map((i) => [i.sku_id, i.proposed_qty]).sort(), [["A", 10], ["C", 10]]);
});

Deno.test("线上合计 > 仓库可分配（多个 listing 共用）：不调减、不算超卖", () => {
  const slots = [slot({ sku_id: "A", qty: 60, sold: 10 }), slot({ sku_id: "B", qty: 60, sold: 10 })];
  const r = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 65 }), overrides: new Map(), params: P });
  eq([r.items.length, r.groups[0].risk], [0, undefined]);
});

Deno.test("国内仓：不绑定，凡未绑定到海外仓的 TikTok 仓库都算国内仓；只预警可售 < 10 天的", () => {
  const cn: Warehouse = { code: "CN", name: "国内仓", kind: "cn", status: "active", region: null, links: [] };
  const slots = [
    slot({ sku_id: "A", tts_warehouse_id: "W_CN", qty: 10, sold: 30 }), // 3/天 → 3.3 天 → 预警，建议补到 60
    slot({ sku_id: "B", tts_warehouse_id: "W_CN", qty: 50, sold: 30 }), // 16.7 天
    slot({ sku_id: "C", tts_warehouse_id: "W_CN", qty: 0, sold: 0 }),   // 无销量不预警
    slot({ sku_id: "D", tts_warehouse_id: "W_PH", qty: 1, sold: 30 }),  // 绑定在海外仓 → 不算国内仓
  ];
  const items = planCn([cn, { ...whPH, status: "disabled" }], slots, P);
  eq(items.map((i) => [i.sku_id, i.warehouse_code, i.proposed_qty, i.days_before]), [["A", "CN", 60, 3.3]]);
  eq(items[0].warnings[0].includes("仅预警"), true);
});
Deno.test("销量：取消单不计；无仓库的按已知占比分摊", () => {
  const sold = countSold([
    { status: "COMPLETED", warehouse_id: "W1", line_items: [{ sku_id: "A" }, { sku_id: "A" }] },
    { status: "CANCELLED", warehouse_id: "W1", line_items: [{ sku_id: "A" }] },
    { status: "AWAITING_SHIPMENT", line_items: [{ sku_id: "A" }, { sku_id: "A" }, { sku_id: "A", display_status: "CANCELLED" }] },
  ]);
  eq([...sold.entries()].sort(), [["A|", 2], ["A|W1", 2]]);
  const slots = applySold([slot({ sku_id: "A", tts_warehouse_id: "W1" }), slot({ sku_id: "A", tts_warehouse_id: "W2" })], sold);
  eq(slots.map((s) => s.sold), [4, 0]);
});

Deno.test("映射表变化", () => {
  const a = { shop_id: "PH1", sku_id: "A", product_id: "P", seller_sku: "X", wh_sku: "X" };
  const d = diffMap([a, { ...a, sku_id: "B" }], [{ ...a, seller_sku: "Y", wh_sku: "Y" }, { ...a, sku_id: "C" }]);
  eq([d.added.length, d.removed.length, d.changed.length], [1, 1, 1]);
});

Deno.test("执行时扣掉计划后已卖出的件数；国内仓不扣", () => {
  eq(execQty({ kind: "overseas", current_qty: 10, proposed_qty: 50 }, 7), 47);
  eq(execQty({ kind: "overseas", current_qty: 10, proposed_qty: 50 }, 12), 50);
  eq(execQty({ kind: "cn", current_qty: 10, proposed_qty: 50 }, 7), 50);
});

Deno.test("紧急度排序", () => {
  const base = { kind: "overseas" as const, warehouse_code: "", wh_sku: "", shop_id: "", region: null, product_id: "", sku_id: "", seller_sku: "", title: null, tts_warehouse_id: "", current_qty: 10, proposed_qty: 0, daily_sales: 1, days_after: null, wh_available: null, pool: null, reason: "", warnings: [], new_link: false };
  const s = sortByUrgency([{ ...base, sku_id: "x", days_before: 8 }, { ...base, sku_id: "n", days_before: null, new_link: true }, { ...base, sku_id: "y", days_before: 1 }]);
  eq(s.map((i) => i.sku_id), ["y", "x", "n"]);
});

// ── 临时组合款（2026-11-18 负责人：AR108+B4 这类临时组合也要分配，按单品库存） ──

Deno.test("组合解析：空格、(组合) 后缀、同单品两件、*n", () => {
  const m = (s: string) => [...(parseCombo(s) ?? new Map()).entries()];
  eq(m("AR108+ B4"), [["AR108", 1], ["B4", 1]]);
  eq(m("AR1063+B4(组合)"), [["AR1063", 1], ["B4", 1]]);
  eq(m("AR141+AR104-B  组合"), [["AR141", 1], ["AR104-B", 1]]);
  eq(m("AR372-2+ AR372-2"), [["AR372-2", 2]]);
  eq(m("AR1+B4*2"), [["AR1", 1], ["B4", 2]]);
  eq(parseCombo("AR245-B4"), null);
});

const whTH: Warehouse = { code: "BS-TH", name: "BigSeller TH 新仓", kind: "overseas", status: "active", region: "TH", links: [{ shop_id: "TH1", tts_warehouse_id: "W" }] };
const th = (o: Partial<Slot>) => slot({ shop_id: "TH1", region: "TH", tts_warehouse_id: "W", ...o });
const run = (slots: Slot[], st: Record<string, number>) =>
  planOverseas({ warehouses: [whTH], slots, stock: stock("BS-TH", st), overrides: new Map(), params: P });

Deno.test("包装 B4 被多个组合共用：B4 按组合销量分，没有单品 listing 的剩余补给天数最短的组合", () => {
  const r = run([
    th({ sku_id: "A", seller_sku: "AR108+B4", qty: 0, sold: 30 }),   // 日销 3
    th({ sku_id: "B", seller_sku: "AR1084+B4", qty: 0, sold: 10 }),  // 日销 1
  ], { AR108: 1000, AR1084: 1000, B4: 46 });
  // B4 可分配 41：A 份额 41×3/4=30.75→30，B 10.25→10；剩 1 件补给天数最短的（A 30/3=10 天，B 10/1=10 天 → 并列取先者）
  const got = Object.fromEntries(r.items.map((i) => [i.sku_id, i.proposed_qty]));
  eq([got.A, got.B], [31, 10]);
});

Deno.test("组合款单品缺货（仓库没有该单品）→ 不调整，并列出缺哪个", () => {
  const r = run([th({ sku_id: "C", seller_sku: "AR138-B-1-60+AR339-B19", qty: 1, sold: 10 })], { "AR138-B-1-60": 160 });
  eq(r.items.length, 0);
  eq(r.groups[0].note.includes("AR339-B19"), true);
});

Deno.test("预组装到货后：仓库有同名实物 SKU 时按实物分配，不再拆单品", () => {
  const r = run([
    th({ sku_id: "C", seller_sku: "AR108+B4", qty: 1, sold: 10 }),
    th({ sku_id: "S", seller_sku: "AR108", qty: 50, sold: 1 }),
  ], { "AR108+B4": 25, AR108: 100, B4: 10 });
  eq(r.items.map((i) => [i.sku_id, i.proposed_qty, i.reason?.includes("组合") ?? false]), [["C", 20, false]]);
});

Deno.test("本地日期：PH UTC+8 / TH UTC+7 跨日边界", () => {
  const t = Date.parse("2026-11-17T16:30:00Z") / 1000; // PH 11-18 00:30，TH 11-17 23:30
  eq([localDay(t, 8), localDay(t, 7)], ["2026-11-18", "2026-11-17"]);
  eq(dayStartSec("2026-11-18", 8), Date.parse("2026-11-17T16:00:00Z") / 1000);
  eq(addDays("2026-03-01", -1), "2026-02-28");
});

Deno.test("滚动拉取起点：首次 60 天；之后上次同步日 − 2；断档太久不早于 60 天", () => {
  eq(salesPullStart("2026-11-18", null), "2026-09-19");
  eq(salesPullStart("2026-11-18", "2026-11-18"), "2026-11-16");
  eq(salesPullStart("2026-11-18", "2026-11-17"), "2026-11-15");
  eq(salesPullStart("2026-11-18", "2026-08-01"), "2026-09-19");
});

Deno.test("窗口销量只取昨天往前 N 个完整日，不含今天", () => {
  const rows = [
    { sku_id: "A", warehouse_id: "W", day: "2026-11-18", units: 99 }, // 今天，不计
    { sku_id: "A", warehouse_id: "W", day: "2026-11-17", units: 3 },
    { sku_id: "A", warehouse_id: "W", day: "2026-11-04", units: 5 },  // 第 14 天，计入
    { sku_id: "A", warehouse_id: "W", day: "2026-11-03", units: 7 },  // 第 15 天，不计
    { sku_id: "A", warehouse_id: "", day: "2026-11-10", units: 1 },
  ];
  eq([...windowSold(rows, "2026-11-18", 14).entries()].sort(), [["A|", 1], ["A|W", 8]]);
});

// ── 最少改动分配（负责人 2026-11-18：全部 ≥ 预警天数不动；要动也尽量少动，先用仓库未分配，再从可售最多的挪） ──
// P：window_days=10、预警 min_days=10、目标 target_days=30、预留 5、min_qty 5、zero_sale_qty 5

Deno.test("全部 listing ≥ 预警天数：即使分布不均也一条都不改", () => {
  const slots = [slot({ sku_id: "A", qty: 12, sold: 10 }), slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "B", qty: 500, sold: 10 })]; // 12 天 / 500 天
  const { items, groups } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 600 }), overrides: new Map(), params: P });
  eq(items.length, 0);
  eq(groups[0].triggered, false);
});

Deno.test("低于预警：先用仓库未分配补到目标天数，不动其他 listing", () => {
  const slots = [slot({ sku_id: "A", qty: 5, sold: 20 }), slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "B", qty: 40, sold: 20 })];
  // 可分配 195，已占 45，未分配 150 → A 补到 30 天 × 2 = 60
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 200 }), overrides: new Map(), params: P });
  eq(items.map((i) => [i.sku_id, i.current_qty, i.proposed_qty]), [["A", 5, 60]]);
  eq(items[0].reason?.includes("仓库未分配 55 件"), true);
});

Deno.test("未分配不够：从可售天数最多的 listing 调，且只动它一条（不动中间的）", () => {
  const slots = [
    slot({ sku_id: "A", qty: 2, sold: 10 }),                                            // 1/天，2 天 → 低
    slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "B", qty: 100, sold: 10 }), // 100 天
    slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "C", qty: 40, sold: 10 }),  // 40 天
  ];
  // 可分配 142 = 已占满 → A 补到 30：全部从 B 调 28 件，C 不动
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 147 }), overrides: new Map(), params: P });
  eq(items.map((i) => [i.sku_id, i.proposed_qty]).sort(), [["A", 30], ["B", 72]]);
  eq(items.find((i) => i.sku_id === "B")!.reason?.includes("调出 28 件"), true);
});

Deno.test("库存紧张：从高于预警的部分调，双方天数拉平，不把对方压到比自己低", () => {
  const slots = [slot({ sku_id: "A", qty: 5, sold: 20 }), slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "B", qty: 80, sold: 20 })];
  // 可分配 100：未分配 15；B 目标线 60 → 先调 20；再从预警以上部分调到两边接近（A 49 = 24.5 天、B 51 = 25.5 天）
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 105 }), overrides: new Map(), params: P });
  eq(items.map((i) => [i.sku_id, i.current_qty, i.proposed_qty]), [["A", 5, 49], ["B", 80, 51]]);
});

Deno.test("无销量的 listing 不预警、不补货（即使 < 5 件）", () => {
  const slots = [slot({ sku_id: "A", qty: 2, sold: 0 }), slot({ sku_id: "B", qty: 30, sold: 10 })];
  const { items, groups } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 45 }), overrides: new Map(), params: P });
  eq(items.length, 0);
  eq(groups[0].triggered, false);
});

Deno.test("无销量的 listing：仓库实际 0、线上还挂着 → 调到 0", () => {
  const { items } = planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", qty: 2, sold: 0 })], stock: stock("QY-PH", { "AR140-B2": 0 }), overrides: new Map(), params: P });
  eq(items.map((i) => [i.proposed_qty, i.daily_sales]), [[0, 0]]);
});

Deno.test("仓库实际 0：压到 0，并提示目标 0 与需补货；仓库 ≤ 预留但不为 0 时不压", () => {
  const { items } = planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", qty: 3, sold: 10 })], stock: stock("QY-PH", { "AR140-B2": 0 }), overrides: new Map(), params: P });
  eq([items[0].proposed_qty, items[0].warnings.length], [0, 2]);
  const r2 = planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", qty: 3, sold: 10 })], stock: stock("QY-PH", { "AR140-B2": 4 }), overrides: new Map(), params: P });
  eq(r2.items.length, 0);
});

Deno.test("新仓 onboarding：listing 未挂新仓 → 首次设置到目标天数（listing 合计销量）", () => {
  const th1: Warehouse = { code: "DM-TH1", name: "顶妙 TH1", kind: "overseas", status: "phasing_out", region: "TH", links: [{ shop_id: "TH1", tts_warehouse_id: "W_OLD" }] };
  const th2: Warehouse = { code: "TH2", name: "泰国新仓", kind: "overseas", status: "onboarding", region: "TH", links: [{ shop_id: "TH1", tts_warehouse_id: "W_NEW" }] };
  const slots = [slot({ shop_id: "TH1", region: "TH", sku_id: "A", tts_warehouse_id: "W_OLD", qty: 30, sold: 10 })];
  const st = new Map([["DM-TH1", new Map([["AR140-B2", 40]])], ["TH2", new Map([["AR140-B2", 105]])]]);
  const { items } = planOverseas({ warehouses: [th1, th2], slots, stock: st, overrides: new Map(), params: P });
  eq(items.map((i) => [i.warehouse_code, i.new_link, i.current_qty, i.proposed_qty, i.tts_warehouse_id]), [["TH2", true, 0, 30, "W_NEW"]]);
});

Deno.test("组合款与单品共用库存：两者都低时按天数拉平，单品合计不超可分配", () => {
  const r = run([
    th({ sku_id: "S", seller_sku: "AR108", qty: 5, sold: 20 }),
    th({ sku_id: "C", seller_sku: "AR108+B4", qty: 10, sold: 20 }),
  ], { AR108: 105, B4: 55 });
  const q = Object.fromEntries(r.items.map((i) => [i.sku_id, i.proposed_qty]));
  eq(q.S + q.C, 100);
  eq(Math.abs(q.S - q.C) <= 1, true);
  eq(r.groups[0].note.includes("单品组套"), true);
});

Deno.test("同单品两件的组合：每套占 2 件，库存够时两者都补到目标", () => {
  const r = run([
    th({ sku_id: "S", seller_sku: "AR372-2", qty: 1, sold: 10 }),
    th({ sku_id: "C", seller_sku: "AR372-2+ AR372-2", qty: 1, sold: 10 }),
  ], { "AR372-2": 145 });
  eq(r.items.map((i) => [i.sku_id, i.proposed_qty]).sort(), [["C", 30], ["S", 30]]); // 30 + 30×2 = 90 ≤ 140
});

Deno.test("组合款调货：某单品凑不齐时不白调别人（回滚）", () => {
  // C=AR1+B4 低；AR1 只能从 S 调，B4 没有任何来源 → C 加不上，S 也不应被改
  const r = run([
    th({ sku_id: "S", seller_sku: "AR1", qty: 200, sold: 10 }),
    th({ sku_id: "C", seller_sku: "AR1+B4", qty: 0, sold: 10 }),
  ], { AR1: 205, B4: 5 });
  eq(r.items.map((i) => i.sku_id), []);
});

Deno.test("预组装实物：有可分配只按实物（不叠加单品）；没货 → 单品组套；单品凑不齐 → 只按实物", () => {
  const a = run([th({ sku_id: "C", seller_sku: "AR108+B4", qty: 0, sold: 10 })], { "AR108+B4": 10, AR108: 25, B4: 25 });
  eq(a.items.map((i) => [i.proposed_qty, i.warnings.some((w) => w.includes("单品组套"))]), [[5, false]]);
  const b = run([th({ sku_id: "C", seller_sku: "AR108+B4", qty: 2, sold: 10 })], { "AR108+B4": 3, AR108: 105, B4: 45 });
  eq(b.items.map((i) => [i.proposed_qty, i.warnings.some((w) => w.includes("单品组套"))]), [[30, true]]);
  const d = run([th({ sku_id: "C", seller_sku: "AR108+B4", qty: 2, sold: 10 })], { "AR108+B4": 3, AR108: 105 });
  eq(d.items.map((i) => i.proposed_qty), []); // 实物还有 3 件（未到 0），不压
  const z = run([th({ sku_id: "C", seller_sku: "AR108+B4", qty: 2, sold: 10 })], { "AR108+B4": 0, AR108: 105 });
  eq(z.items.map((i) => i.proposed_qty), [0]); // 实物 0 且单品凑不齐 → 调到 0
});

Deno.test("跨店铺多个 listing 共用单品：单品实际 0 → 用到它的 listing（含组合款）全部调到 0 并记超卖", () => {
  const two: Warehouse = { ...whTH, links: [{ shop_id: "TH1", tts_warehouse_id: "W" }, { shop_id: "TH2", tts_warehouse_id: "W2" }] };
  const r = planOverseas({
    warehouses: [two],
    slots: [
      th({ sku_id: "A", seller_sku: "AR141", qty: 900, sold: 50 }),
      th({ shop_id: "TH2", tts_warehouse_id: "W2", sku_id: "B", seller_sku: "AR141+AR371", qty: 20, sold: 50 }),
    ],
    stock: stock("BS-TH", { AR141: 0, AR371: 205 }), overrides: new Map(), params: P,
  });
  eq(r.items.map((i) => [i.sku_id, i.proposed_qty]).sort(), [["A", 0], ["B", 0]]);
  eq(r.groups[0].risk?.map((x) => [x.kind, x.sku, x.online]), [["oversold", "AR141", 920]]);
});

Deno.test("编码核心与建议映射：MY 仓的 M-…+B4 预装编码", () => {
  const keys = ["M-AR101-A+B4", "M-334-A+B4", "M-AR402+406+B4", "AR1099-B60"];
  eq(suggestWhSku("AR101-A", keys), ["M-AR101-A+B4"]);
  eq(suggestWhSku("AR334-A", keys), ["M-334-A+B4"]);
  eq(suggestWhSku("AR402+AR406", keys), ["M-AR402+406+B4"]);
  eq(suggestWhSku("AR413-B11", ["AR413-B10", "AR413-B8"]), []); // 不同规格不建议
  eq(skuCore("M1094-A3-60+B4"), "1094-A3-60");
});

Deno.test("找不到的 SKU：带出 TikTok 当前可售、listing 明细与建议映射", () => {
  const r = planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", seller_sku: "AR101-A", qty: 7, sold: 10 })], stock: stock("QY-PH", { "M-AR101-A+B4": 50 }), overrides: new Map(), params: P });
  const g = r.groups.find((x) => x.wh_available === null)!;
  eq([g.listing_qty, g.candidates, g.listings!.map((x) => x.sku_id)], [7, ["M-AR101-A+B4"], ["A"]]);
});

Deno.test("无销量的 listing 只用仓库未分配补，不从其他 listing 调", () => {
  // 可分配 40 已全部分给 B（40 件，日销 1 → 40 天，高于目标 30）；A 无销量 2 件 < 5 → 没有未分配，不应从 B 调
  const slots = [slot({ sku_id: "A", qty: 2, sold: 0 }), slot({ sku_id: "B", qty: 38, sold: 10 })];
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 45 }), overrides: new Map(), params: P });
  eq(items.length, 0);
});

// ── 2026-11-28 负责人：无销量线上 0 件且可补 > 10 才提示；所有超卖都提示 ──
Deno.test("无销量：线上 0 件且仓库未分配 > 10 → 提示补到 5；未分配 ≤ 10 或线上还有货 → 不提示", () => {
  const run1 = (qty: number, avail: number) => planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", qty, sold: 0 })], stock: stock("QY-PH", { "AR140-B2": avail }), overrides: new Map(), params: P });
  eq(run1(0, 20).items.map((i) => [i.proposed_qty, i.reason?.includes("无销量")]), [[5, true]]); // 未分配 15 > 10
  eq(run1(0, 15).items.length, 0);  // 未分配 10，不 > 10
  eq(run1(2, 60).items.length, 0);  // 线上还有 2 件
});

Deno.test("超卖①：仓库实际 0、线上还有货（含无销量）→ 记风险并调到 0", () => {
  const r = planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", qty: 2, sold: 0 })], stock: stock("QY-PH", { "AR140-B2": 0 }), overrides: new Map(), params: P });
  eq(r.groups[0].risk, [{ kind: "oversold", sku: "AR140-B2", online: 2, pool: 0, wh_days: null }]);
  eq(r.items.map((i) => i.proposed_qty), [0]);
});

Deno.test("超卖②：仓库只够 < 5 天，但有 listing 线上 > 6 天 → 记风险", () => {
  // 可分配 40，日销合计 10 → 仓库只够 4 天；A 线上 35 件 / 5 件每天 = 7 天 > 6
  const slots = [slot({ sku_id: "A", qty: 35, sold: 50 }), slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "B", qty: 0, sold: 50 })];
  const r = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 45 }), overrides: new Map(), params: P });
  eq(r.groups[0].risk?.map((x) => [x.kind, x.wh_days]), [["short", 4]]);
});

Deno.test("库存充足时不记风险", () => {
  const r = planOverseas({ warehouses: [whPH], slots: [slot({ sku_id: "A", qty: 35, sold: 50 })], stock: stock("QY-PH", { "AR140-B2": 505 }), overrides: new Map(), params: P });
  eq(r.groups[0].risk, undefined);
});
