// 跑法：deno test supabase/functions/_shared/sea-inventory.test.ts
import {
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

Deno.test("海外仓：任一 listing 可售 < 10 天 → 整组按销量重分；扣预留 5；合计 = 池子", () => {
  const slots = [
    slot({ sku_id: "A", qty: 5, sold: 20 }), // 2/天 → 2.5 天，触发
    slot({ shop_id: "PH2", tts_warehouse_id: "W_PH2", sku_id: "B", qty: 80, sold: 20 }), // 2/天 → 40 天
  ];
  const { items, groups } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 105 }), overrides: new Map(), params: P });
  eq(groups[0].pool, 100);
  eq(items.map((i) => [i.sku_id, i.current_qty, i.proposed_qty]), [["A", 5, 50], ["B", 80, 50]]);
  eq(items[0].days_before, 2.5);
  eq(items[0].days_after, 25);
});

Deno.test("海外仓：都健康 → 不调整", () => {
  const slots = [slot({ sku_id: "A", qty: 40, sold: 20 }), slot({ sku_id: "B", qty: 40, sold: 10 })];
  const { items, groups } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 200 }), overrides: new Map(), params: P });
  eq(items.length, 0);
  eq(groups[0].triggered, false);
});

Deno.test("海外仓：数量 < 5 也触发（即使无销量）", () => {
  const slots = [slot({ sku_id: "A", qty: 2, sold: 0 }), slot({ sku_id: "B", qty: 30, sold: 10 })];
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 45 }), overrides: new Map(), params: P });
  // 池子 40；无销量 A 拿 min(5, 40*0.2=8)=5，B 拿 35
  eq(items.map((i) => [i.sku_id, i.proposed_qty]), [["A", 5], ["B", 35]]);
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

Deno.test("海外仓：仓库可用 ≤ 预留 → 目标 0 并给出警告", () => {
  const slots = [slot({ sku_id: "A", qty: 3, sold: 10 })];
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 4 }), overrides: new Map(), params: P });
  eq(items[0].proposed_qty, 0);
  eq(items[0].warnings.length, 1);
});

Deno.test("海外仓：listing 合计超过可分配量（超卖风险）→ 即使天数够也压回", () => {
  const slots = [slot({ sku_id: "A", qty: 60, sold: 10 }), slot({ sku_id: "B", qty: 60, sold: 10 })];
  const { items } = planOverseas({ warehouses: [whPH], slots, stock: stock("QY-PH", { "AR140-B2": 65 }), overrides: new Map(), params: P });
  eq(items.map((i) => i.proposed_qty), [30, 30]);
});

Deno.test("新仓 onboarding：listing 未挂新仓 → 生成首次设置项，用 listing 合计销量", () => {
  const th1: Warehouse = { code: "DM-TH1", name: "顶妙 TH1", kind: "overseas", status: "phasing_out", region: "TH", links: [{ shop_id: "TH1", tts_warehouse_id: "W_OLD" }] };
  const th2: Warehouse = { code: "TH2", name: "泰国新仓", kind: "overseas", status: "onboarding", region: "TH", links: [{ shop_id: "TH1", tts_warehouse_id: "W_NEW" }] };
  const slots = [slot({ shop_id: "TH1", region: "TH", sku_id: "A", tts_warehouse_id: "W_OLD", qty: 30, sold: 10 })];
  const st = new Map([["DM-TH1", new Map([["AR140-B2", 40]])], ["TH2", new Map([["AR140-B2", 105]])]]);
  const { items } = planOverseas({ warehouses: [th1, th2], slots, stock: st, overrides: new Map(), params: P });
  const n = items.find((i) => i.warehouse_code === "TH2")!;
  eq([n.new_link, n.current_qty, n.proposed_qty, n.tts_warehouse_id], [true, 0, 100, "W_NEW"]);
  // 旧仓：30 天够，但合计 30 ≤ 池子 35 → 不调
  eq(items.filter((i) => i.warehouse_code === "DM-TH1").length, 0);
});

Deno.test("国内仓：只补可售 < 10 天，补到 20 天；无销量不补", () => {
  const cn: Warehouse = { code: "CN", name: "国内仓", kind: "cn", status: "active", region: null, links: [{ shop_id: "PH1", tts_warehouse_id: "W_CN" }] };
  const slots = [
    slot({ sku_id: "A", tts_warehouse_id: "W_CN", qty: 10, sold: 30 }), // 3/天 → 3.3 天 → 补到 60
    slot({ sku_id: "B", tts_warehouse_id: "W_CN", qty: 50, sold: 30 }), // 16.7 天
    slot({ sku_id: "C", tts_warehouse_id: "W_CN", qty: 0, sold: 0 }),
  ];
  const items = planCn([cn], slots, P);
  eq(items.map((i) => [i.sku_id, i.proposed_qty, i.days_before]), [["A", 60, 3.3]]);
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
