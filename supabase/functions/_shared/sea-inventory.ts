// SEA 库存监控：调整计划纯函数（无 IO，便于单测）。
//
// 名词：
//   仓库（Warehouse）   = 一个实体仓（千易 MY / 千易 PH / 顶妙 TH1 / BigSeller VN / 泰国新仓 / 国内仓），
//                         通过 links 绑定到各店铺在 TikTok 里的 warehouse_id。
//   槽位（Slot）        = 某店铺某 SKU（listing 的一个变体）在某个 TikTok 仓库上的库存，
//                         Update Inventory 接口就是按 (product_id, sku_id, warehouse_id) 设数量。
//   仓库 SKU（whSku）   = 海外仓系统里的 SKU 编码。listing 的 seller_sku 与它**完全一致**（只去首尾空格，区分大小写）
//                         才视为同一实物；包装不同（B2/B4…）编码不同，自然不会合并。可人工覆盖映射。
//
// 规则（负责人 2026-11-17 口径；标「待确认」的是本实现自定的默认值，页面可改）：
//   海外仓：可分配池 = 仓库可用 − 每 SKU 预留（默认 5）。同一仓库 SKU 下任一槽位「可售天数 < 10 或 数量 < 5」时，
//          整组按近 N 天销量占比重新分配池子（sum(目标) = 池子，绝不超卖）；无销量的槽位先各拿 zero_sale_qty（待确认，默认 5，
//          合计不超过池子 20%）。只输出与当前不同的槽位。
//   国内仓：只补「可售天数 < 10」的槽位，补到 cn_target_days 天销量（待确认，默认 20 天）；国内仓实物库存未知，需人工确认。
//   新仓（onboarding）：listing 还没挂新仓时生成「虚拟槽位」（当前 0），用 listing 全部仓库合计销量分配，执行时 INCREMENTAL 自动建关联。

export type WarehouseKind = "overseas" | "cn";
export type WarehouseStatus = "active" | "onboarding" | "phasing_out" | "disabled";

export type Warehouse = {
  code: string;
  name: string;
  kind: WarehouseKind;
  status: WarehouseStatus;
  region: string | null;
  links: Array<{ shop_id: string; tts_warehouse_id: string }>;
};

export type Slot = {
  shop_id: string;
  region: string | null;
  product_id: string;
  sku_id: string;
  seller_sku: string;
  title: string | null;
  tts_warehouse_id: string;
  qty: number; // TikTok 当前可售（available_quantity）
  sold: number; // 统计窗口内从该仓发出的件数
  virtual?: boolean; // 新仓虚拟槽位（listing 尚未挂这个仓）
};

export type Params = {
  window_days: number;
  min_days: number;
  min_qty: number;
  reserve_per_sku: number;
  zero_sale_qty: number;
  cn_min_days: number;
  cn_target_days: number;
};

export const DEFAULT_PARAMS: Params = {
  window_days: 14,
  min_days: 10,
  min_qty: 5,
  reserve_per_sku: 5,
  zero_sale_qty: 5,
  cn_min_days: 10,
  cn_target_days: 20,
};

export type PlanItem = {
  kind: WarehouseKind;
  warehouse_code: string;
  wh_sku: string;
  shop_id: string;
  region: string | null;
  product_id: string;
  sku_id: string;
  seller_sku: string;
  title: string | null;
  tts_warehouse_id: string;
  current_qty: number;
  proposed_qty: number;
  daily_sales: number;
  days_before: number | null; // null = 无销量（无穷）
  days_after: number | null;
  wh_available: number | null; // 海外仓实物可用（国内仓 null）
  pool: number | null;
  reason: string;
  warnings: string[];
  new_link: boolean;
};

export type GroupStatus = {
  warehouse_code: string;
  wh_sku: string;
  wh_available: number | null;
  pool: number | null;
  slots: number;
  triggered: boolean;
  note: string;
};

export function normSku(s: string | null | undefined): string {
  return String(s ?? "").trim();
}

export function daysOf(qty: number, daily: number): number | null {
  if (!(daily > 0)) return null;
  return qty / daily;
}

const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/**
 * 最大余数法：把整数 total 按权重分成整数，合计严格等于 total。
 * 权重全 0 时平均分。
 */
export function largestRemainder(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (!n) return [];
  if (total <= 0) return weights.map(() => 0);
  const sumW = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const ws = sumW > 0 ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1);
  const S = sumW > 0 ? sumW : n;
  const raw = ws.map((w) => (total * w) / S);
  const out = raw.map((x) => Math.floor(x));
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x), w: ws[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k].i]++;
  return out;
}

/**
 * 海外仓一组（同一仓库 × 同一仓库 SKU）的目标分配。
 * 返回与 slots 同序的目标数量。
 */
export function allocatePool(pool: number, daily: number[], p: Pick<Params, "zero_sale_qty">): number[] {
  const n = daily.length;
  if (pool <= 0) return daily.map(() => 0);
  const zeroIdx = daily.map((d, i) => (d > 0 ? -1 : i)).filter((i) => i >= 0);
  const sellIdx = daily.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
  const out = new Array<number>(n).fill(0);
  if (!sellIdx.length) {
    // 全部无销量：平均分
    const parts = largestRemainder(pool, daily.map(() => 1));
    parts.forEach((q, i) => (out[i] = q));
    return out;
  }
  // 无销量槽位：每个先拿 zero_sale_qty，但合计不超过池子 20%（向下取整）
  let zeroEach = 0;
  if (zeroIdx.length) {
    const cap = Math.floor((pool * 0.2) / zeroIdx.length);
    zeroEach = Math.max(0, Math.min(p.zero_sale_qty, cap));
  }
  for (const i of zeroIdx) out[i] = zeroEach;
  const rest = pool - zeroEach * zeroIdx.length;
  const parts = largestRemainder(rest, sellIdx.map((i) => daily[i]));
  sellIdx.forEach((i, k) => (out[i] = parts[k]));
  return out;
}

export type OverseasInput = {
  warehouses: Warehouse[];
  slots: Slot[];
  /** warehouse_code → (whSku → 可用数量) */
  stock: Map<string, Map<string, number>>;
  /** `${shop_id}|${sku_id}` → 人工指定的仓库 SKU */
  overrides: Map<string, string>;
  params: Params;
};

export function whSkuOf(slot: Pick<Slot, "shop_id" | "sku_id" | "seller_sku">, overrides: Map<string, string>): string {
  return normSku(overrides.get(`${slot.shop_id}|${slot.sku_id}`) ?? slot.seller_sku);
}

/** 新仓虚拟槽位：同店铺已挂在其他仓、但还没挂这个新仓的 SKU，各补一个 qty=0 的槽位；销量取该 SKU 全部仓库合计。 */
export function addOnboardingSlots(warehouses: Warehouse[], slots: Slot[]): Slot[] {
  const out = [...slots];
  const totalSold = new Map<string, number>();
  const firstSlot = new Map<string, Slot>();
  for (const s of slots) {
    const k = `${s.shop_id}|${s.sku_id}`;
    totalSold.set(k, (totalSold.get(k) ?? 0) + s.sold);
    if (!firstSlot.has(k)) firstSlot.set(k, s);
  }
  for (const w of warehouses) {
    if (w.kind !== "overseas" || w.status !== "onboarding") continue;
    for (const link of w.links) {
      const have = new Set(slots.filter((s) => s.shop_id === link.shop_id && s.tts_warehouse_id === link.tts_warehouse_id).map((s) => s.sku_id));
      for (const [k, s] of firstSlot) {
        if (s.shop_id !== link.shop_id || have.has(s.sku_id)) continue;
        out.push({ ...s, tts_warehouse_id: link.tts_warehouse_id, qty: 0, sold: totalSold.get(k) ?? 0, virtual: true });
      }
    }
  }
  return out;
}

/** listing 商家 SKU → 组合构成（单品 → 件数）。不含「+」返回 null。去掉末尾「(组合)」「组合」「(临时组合)」，支持「SKU*2」。 */
export function parseCombo(sku: string): Map<string, number> | null {
  const s = normSku(sku);
  if (!s.includes("+")) return null;
  const out = new Map<string, number>();
  for (let part of s.split("+")) {
    part = part.replace(/[（(]?\s*(临时)?组合\s*[)）]?\s*$/, "").trim();
    if (!part) continue;
    const m = part.match(/^(.+?)\s*[*×]\s*(\d+)$/);
    const k = (m ? m[1] : part).trim();
    out.set(k, (out.get(k) ?? 0) + (m ? Number(m[2]) : 1));
  }
  return out.size ? out : null;
}

type Consumer = { slot: Slot; whSku: string; comps: Map<string, number>; daily: number };

/**
 * 单品簇分配（有临时组合款时）：组合款与单品共用单品库存。
 *   可分配（每个单品）= 仓库可用 − 预留；
 *   ① 无销量的 listing 各拿 zero_sale_qty（每个单品合计不超过其可分配 20%）；
 *   ② 有销量的组合款：在每个单品上按「日销 × 用量」占比拿份额，组合可设数量 = 各单品份额 ÷ 用量 的最小值；
 *   ③ 单品 listing 分该单品剩余（按日销占比）；④ 只被组合用到的单品（如包装 B4）剩余，再逐件补给可售天数最短的组合。
 *   任何单品上的消耗合计都不超过其可分配量（不超卖）。
 */
export function planCluster(w: Warehouse, cs: Consumer[], stock: Map<string, number>, p: Params): { items: PlanItem[]; group: GroupStatus } {
  const skus = [...new Set(cs.flatMap((c) => [...c.comps.keys()]))].sort();
  const pool = new Map(skus.map((k) => [k, Math.max(0, (stock.get(k) ?? 0) - p.reserve_per_sku)]));
  const cap = (c: Consumer, m: Map<string, number>) => Math.min(...[...c.comps].map(([k, q]) => Math.floor((m.get(k) ?? 0) / q)));
  const isCombo = (c: Consumer) => c.comps.size > 1 || [...c.comps.values()][0] > 1 || !c.comps.has(c.whSku);
  const label = skus.join("+");
  const triggered = cs.some((c) => {
    if (c.slot.virtual) return cap(c, pool) > 0;
    const d = daysOf(c.slot.qty, c.daily);
    return c.slot.qty < p.min_qty || (d !== null && d < p.min_days);
  });
  const used = new Map(skus.map((k) => [k, 0]));
  for (const c of cs) if (!c.slot.virtual) for (const [k, q] of c.comps) used.set(k, used.get(k)! + c.slot.qty * q);
  const overSold = skus.some((k) => used.get(k)! > pool.get(k)!);
  const group: GroupStatus = {
    warehouse_code: w.code, wh_sku: label, wh_available: Math.min(...skus.map((k) => stock.get(k) ?? 0)), pool: Math.min(...skus.map((k) => pool.get(k)!)),
    slots: cs.length, triggered: triggered || overSold,
    note: `含临时组合款（单品 ${skus.join("、")}）：${overSold ? "当前合计超过单品可分配量，按销量压回" : triggered ? "触发调整" : "无需调整"}`,
  };
  if (!triggered && !overSold) return { items: [], group };

  const target = new Map<Consumer, number>(cs.map((c) => [c, 0]));
  const rem = new Map(pool);
  const take = (c: Consumer, n: number) => { target.set(c, target.get(c)! + n); for (const [k, q] of c.comps) rem.set(k, rem.get(k)! - n * q); };
  const sel = cs.filter((c) => c.daily > 0);
  const zero = cs.filter((c) => !(c.daily > 0));
  if (!sel.length) {
    // 全部无销量：按单品平均
    for (const c of zero) {
      const n = Math.min(...[...c.comps].map(([k, q]) => Math.floor(pool.get(k)! / (zero.filter((z) => z.comps.has(k)).reduce((t, z) => t + z.comps.get(k)!, 0)))));
      take(c, Math.max(0, n));
    }
  } else {
    // ① 无销量保底
    for (const c of zero) {
      const n = Math.min(p.zero_sale_qty, ...[...c.comps].map(([k, q]) => Math.floor(Math.floor(pool.get(k)! * 0.2) / (q * zero.filter((z) => z.comps.has(k)).length))));
      take(c, Math.max(0, n));
    }
    // ② 组合款按份额
    const snap = new Map(rem);
    const denom = new Map(skus.map((k) => [k, sel.filter((c) => c.comps.has(k)).reduce((t, c) => t + c.daily * c.comps.get(k)!, 0)]));
    for (const c of sel.filter(isCombo)) {
      const n = Math.min(...[...c.comps].map(([k, q]) => Math.floor((snap.get(k)! * c.daily * q / denom.get(k)!) / q)));
      take(c, Math.max(0, n));
    }
    // ③ 单品 listing 分剩余
    for (const k of skus) {
      const singles = sel.filter((c) => !isCombo(c) && c.whSku === k);
      if (!singles.length) continue;
      const parts = largestRemainder(Math.max(0, rem.get(k)!), singles.map((c) => c.daily));
      singles.forEach((c, i) => take(c, parts[i]));
    }
    // ④ 剩余补给可售天数最短的组合款
    const combosSel = sel.filter(isCombo);
    for (let guard = 0; guard < 100_000 && combosSel.length; guard++) {
      const ok = combosSel.filter((c) => cap(c, rem) >= 1);
      if (!ok.length) break;
      ok.sort((a, b) => target.get(a)! / a.daily - target.get(b)! / b.daily);
      take(ok[0], 1);
    }
  }

  const items: PlanItem[] = [];
  for (const c of cs) {
    const s = c.slot;
    const t = target.get(c)!;
    if (t === s.qty || (s.virtual && t === 0)) continue;
    const combo = isCombo(c);
    const compText = [...c.comps].map(([k, q]) => (q > 1 ? `${k}×${q}` : k)).join(" + ");
    const warnings: string[] = [];
    if (t === 0) warnings.push("目标为 0：官方文档写 quantity 范围 1–99,999，设 0 未实测，可能需改为解除仓库关联");
    if (w.status === "phasing_out") warnings.push("旧仓逐步退出中");
    const before = daysOf(s.qty, c.daily);
    const avail = combo ? cap(c, stock) : stock.get(c.whSku) ?? 0;
    const pl = combo ? cap(c, pool) : pool.get(c.whSku)!;
    const why = s.virtual ? `新仓首次设置库存（listing 尚未关联 ${w.name}）`
      : combo ? `临时组合款（${compText}），与单品共用库存，按销量占比分配`
      : `单品与临时组合款共用库存（${label}），按销量占比分配`;
    items.push({
      kind: "overseas", warehouse_code: w.code, wh_sku: c.whSku, shop_id: s.shop_id, region: s.region,
      product_id: s.product_id, sku_id: s.sku_id, seller_sku: s.seller_sku, title: s.title, tts_warehouse_id: s.tts_warehouse_id,
      current_qty: s.qty, proposed_qty: t, daily_sales: Math.round(c.daily * 100) / 100,
      days_before: r1(before), days_after: r1(daysOf(t, c.daily)), wh_available: avail, pool: pl, reason: why, warnings, new_link: !!s.virtual,
    });
  }
  return { items, group };
}

export function planOverseas(input: OverseasInput): { items: PlanItem[]; groups: GroupStatus[] } {
  const { params: p } = input;
  const items: PlanItem[] = [];
  const groups: GroupStatus[] = [];
  const slots = addOnboardingSlots(input.warehouses, input.slots);
  // 新仓：真实槽位的销量也改用 listing 合计（新仓刚接手，自身历史销量不代表需求）
  const totalSold = new Map<string, number>();
  for (const s of input.slots) totalSold.set(`${s.shop_id}|${s.sku_id}`, (totalSold.get(`${s.shop_id}|${s.sku_id}`) ?? 0) + s.sold);

  for (const w of input.warehouses) {
    if (w.kind !== "overseas" || w.status === "disabled") continue;
    const linkKeys = new Set(w.links.map((l) => `${l.shop_id}|${l.tts_warehouse_id}`));
    const mine = slots.filter((s) => linkKeys.has(`${s.shop_id}|${s.tts_warehouse_id}`));
    const byWhSku = new Map<string, Slot[]>();
    for (const s of mine) {
      const k = whSkuOf(s, input.overrides);
      if (!k) continue;
      byWhSku.set(k, [...(byWhSku.get(k) ?? []), s]);
    }
    const stockMap = input.stock.get(w.code);
    const dailyOf = (s: Slot) => (w.status === "onboarding" ? (totalSold.get(`${s.shop_id}|${s.sku_id}`) ?? s.sold) : s.sold) / p.window_days;
    const singleGroup = (whSku: string, g: Slot[]) => {
      // 虚拟槽位只在仓库确实有该 SKU 时才出现
      const avail = stockMap?.get(whSku);
      const real = g.filter((s) => !s.virtual);
      if (avail === undefined) {
        if (real.length) {
          groups.push({ warehouse_code: w.code, wh_sku: whSku, wh_available: null, pool: null, slots: real.length, triggered: false, note: "仓库库存里找不到这个 SKU（编码不一致或仓库无货），未调整" });
        }
        return;
      }
      const useGroup = g;
      const pool = Math.max(0, avail - p.reserve_per_sku);
      const daily = useGroup.map((s) => {
        const sold = w.status === "onboarding" ? (totalSold.get(`${s.shop_id}|${s.sku_id}`) ?? s.sold) : s.sold;
        return sold / p.window_days;
      });
      const triggered = useGroup.some((s, i) => {
        if (s.virtual) return pool > 0; // 新仓有货、listing 还没挂 → 需要首次设置
        const d = daysOf(s.qty, daily[i]);
        return s.qty < p.min_qty || (d !== null && d < p.min_days);
      });
      // 超卖保护：当前合计已超过池子，即使没有触发也要压回来
      const overSold = real.reduce((t, s) => t + s.qty, 0) > pool;
      groups.push({
        warehouse_code: w.code, wh_sku: whSku, wh_available: avail, pool, slots: useGroup.length,
        triggered: triggered || overSold,
        note: overSold ? "listing 库存合计超过仓库可分配量，按销量压回" : triggered ? "触发调整" : "无需调整",
      });
      if (!triggered && !overSold) return;
      const target = allocatePool(pool, daily, p);
      useGroup.forEach((s, i) => {
        if (target[i] === s.qty) return;
        if (s.virtual && target[i] === 0) return;
        const warnings: string[] = [];
        if (target[i] === 0) warnings.push("目标为 0：官方文档写 quantity 范围 1–99,999，设 0 未实测，可能需改为解除仓库关联");
        if (w.status === "phasing_out") warnings.push("旧仓逐步退出中");
        const before = daysOf(s.qty, daily[i]);
        const after = daysOf(target[i], daily[i]);
        const why = s.virtual
          ? `新仓首次设置库存（listing 尚未关联 ${w.name}）`
          : overSold && !triggered
          ? `listing 合计超过仓库可分配 ${pool}，按销量占比压回`
          : s.qty < p.min_qty
          ? `当前 ${s.qty} 件 < ${p.min_qty}，按销量占比重新分配仓库 ${pool} 件`
          : before !== null && before < p.min_days
          ? `可售 ${r1(before)} 天 < ${p.min_days}，按销量占比重新分配仓库 ${pool} 件`
          : `同 SKU 其他 listing 触发调整，按销量占比重新分配仓库 ${pool} 件`;
        items.push({
          kind: "overseas", warehouse_code: w.code, wh_sku: whSku, shop_id: s.shop_id, region: s.region,
          product_id: s.product_id, sku_id: s.sku_id, seller_sku: s.seller_sku, title: s.title, tts_warehouse_id: s.tts_warehouse_id,
          current_qty: s.qty, proposed_qty: target[i], daily_sales: Math.round(daily[i] * 100) / 100,
          days_before: r1(before), days_after: r1(after), wh_available: avail, pool, reason: why, warnings, new_link: !!s.virtual,
        });
      });
    };

    // 分类：仓库有同名 SKU → 实物；否则按「+」拆成单品，全部单品在仓库有库存 → 组合（临时组合，按单品库存分配）；其余 → 找不到
    const physical = new Map<string, Slot[]>();
    const combos = new Map<string, { comps: Map<string, number>; slots: Slot[] }>();
    for (const [whSku, g] of byWhSku) {
      if (stockMap?.has(whSku)) { physical.set(whSku, g); continue; }
      const comps = parseCombo(whSku);
      const real = g.filter((s) => !s.virtual);
      if (comps) {
        const miss = [...comps.keys()].filter((k) => !stockMap?.has(k));
        if (!miss.length) { combos.set(whSku, { comps, slots: g }); continue; }
        if (real.length) groups.push({ warehouse_code: w.code, wh_sku: whSku, wh_available: null, pool: null, slots: real.length, triggered: false, note: `组合款单品在仓库库存里找不到：${miss.join("、")}，未调整` });
        continue;
      }
      singleGroup(whSku, g); // 走原逻辑（会记「找不到」）
    }
    // 被组合用到的单品与这些组合一起按「单品簇」分配，其余单品走原逻辑
    const uf = new Map<string, string>();
    const find = (x: string): string => { while (uf.get(x) !== x) { const px = uf.get(x)!; uf.set(x, uf.get(px)!); x = uf.get(x)!; } return x; };
    for (const { comps } of combos.values()) {
      const ks = [...comps.keys()];
      for (const k of ks) if (!uf.has(k)) uf.set(k, k);
      for (const k of ks.slice(1)) uf.set(find(k), find(ks[0]));
    }
    for (const [whSku, g] of physical) if (!uf.has(whSku)) singleGroup(whSku, g);
    const clusters = new Map<string, Consumer[]>();
    const add = (root: string, c: Consumer) => clusters.set(root, [...(clusters.get(root) ?? []), c]);
    for (const [whSku, g] of physical) if (uf.has(whSku)) for (const s of g) add(find(whSku), { slot: s, whSku, comps: new Map([[whSku, 1]]), daily: dailyOf(s) });
    for (const [whSku, { comps, slots: g }] of combos) for (const s of g) add(find([...comps.keys()][0]), { slot: s, whSku, comps, daily: dailyOf(s) });
    for (const cs of clusters.values()) {
      const r = planCluster(w, cs, stockMap!, p);
      items.push(...r.items);
      groups.push(r.group);
    }
  }
  return { items, groups };
}

export function planCn(warehouses: Warehouse[], slots: Slot[], p: Params): PlanItem[] {
  const items: PlanItem[] = [];
  for (const w of warehouses) {
    if (w.kind !== "cn" || w.status === "disabled") continue;
    const linkKeys = new Set(w.links.map((l) => `${l.shop_id}|${l.tts_warehouse_id}`));
    for (const s of slots) {
      if (s.virtual || !linkKeys.has(`${s.shop_id}|${s.tts_warehouse_id}`)) continue;
      const daily = s.sold / p.window_days;
      const before = daysOf(s.qty, daily);
      if (before === null || before >= p.cn_min_days) continue;
      const target = Math.ceil(daily * p.cn_target_days);
      if (target <= s.qty) continue;
      items.push({
        kind: "cn", warehouse_code: w.code, wh_sku: normSku(s.seller_sku), shop_id: s.shop_id, region: s.region,
        product_id: s.product_id, sku_id: s.sku_id, seller_sku: s.seller_sku, title: s.title, tts_warehouse_id: s.tts_warehouse_id,
        current_qty: s.qty, proposed_qty: Math.min(99_999, target), daily_sales: Math.round(daily * 100) / 100,
        days_before: r1(before), days_after: r1(daysOf(target, daily)), wh_available: null, pool: null,
        reason: `可售 ${r1(before)} 天 < ${p.cn_min_days}，补到 ${p.cn_target_days} 天销量`,
        warnings: ["国内仓实物库存未接入，确认前请核对仓库确有货"], new_link: false,
      });
    }
  }
  return items;
}

/** 紧急度排序：可售天数升序（新仓首次设置排最后），同天数按日销量降序 */
export function sortByUrgency(items: PlanItem[]): PlanItem[] {
  const key = (x: PlanItem) => (x.new_link ? 1e9 : x.days_before ?? (x.current_qty < 5 ? 0 : 1e8));
  return [...items].sort((a, b) => key(a) - key(b) || b.daily_sales - a.daily_sales);
}

// ── 映射表变化 ──────────────────────────────────────────────────────────────
export type MapRow = { shop_id: string; sku_id: string; product_id: string; seller_sku: string; wh_sku: string };
export type MapDiff = { added: MapRow[]; removed: MapRow[]; changed: Array<{ before: MapRow; after: MapRow }> };

export function diffMap(prev: MapRow[], next: MapRow[]): MapDiff {
  const k = (r: MapRow) => `${r.shop_id}|${r.sku_id}`;
  const pm = new Map(prev.map((r) => [k(r), r]));
  const nm = new Map(next.map((r) => [k(r), r]));
  const added: MapRow[] = [];
  const removed: MapRow[] = [];
  const changed: Array<{ before: MapRow; after: MapRow }> = [];
  for (const [key, r] of nm) {
    const o = pm.get(key);
    if (!o) added.push(r);
    else if (o.wh_sku !== r.wh_sku || o.seller_sku !== r.seller_sku) changed.push({ before: o, after: r });
  }
  for (const [key, r] of pm) if (!nm.has(key)) removed.push(r);
  return { added, removed, changed };
}

// ── 销量统计 ────────────────────────────────────────────────────────────────
export type OrderLite = {
  status?: string;
  warehouse_id?: string;
  line_items?: Array<{ sku_id?: string; display_status?: string; is_gift?: boolean }>;
};

/** 一个 line_item = 一件。取消单/取消行不计；赠品计入（同样消耗库存）。key = `${sku_id}|${warehouse_id}` */
export function countSold(orders: OrderLite[], into = new Map<string, number>()): Map<string, number> {
  for (const o of orders) {
    if (/CANCEL|UNPAID/i.test(o.status ?? "")) continue;
    for (const li of o.line_items ?? []) {
      if (!li.sku_id || /CANCEL/i.test(li.display_status ?? "")) continue;
      const k = `${li.sku_id}|${o.warehouse_id ?? ""}`;
      into.set(k, (into.get(k) ?? 0) + 1);
    }
  }
  return into;
}

/**
 * 把按 (sku, 仓库) 统计的销量落到槽位：订单带仓库的按仓库记；没带仓库的，
 * SKU 只有一个仓时记给它，多仓时按各仓已知销量占比分摊（都为 0 则平均）。
 */
export function applySold(slots: Slot[], sold: Map<string, number>): Slot[] {
  const bySku = new Map<string, Slot[]>();
  for (const s of slots) bySku.set(s.sku_id, [...(bySku.get(s.sku_id) ?? []), s]);
  const out: Slot[] = [];
  for (const [sku, g] of bySku) {
    const known = g.map((s) => sold.get(`${sku}|${s.tts_warehouse_id}`) ?? 0);
    const unk = sold.get(`${sku}|`) ?? 0;
    const extra = g.length === 1 ? [unk] : largestRemainder(unk, known.some((x) => x > 0) ? known : g.map(() => 1));
    g.forEach((s, i) => out.push({ ...s, sold: known[i] + extra[i] }));
  }
  return out;
}

// ── 执行前修正 ──────────────────────────────────────────────────────────────
/**
 * 计划生成后到执行之间又卖掉的件数要扣掉（海外仓池子是按生成时快照分的，实物随发货同步减少）。
 * 国内仓按天数补货，目标不变。
 */
export function execQty(item: Pick<PlanItem, "kind" | "current_qty" | "proposed_qty">, liveQty: number | null): number {
  if (liveQty === null || item.kind === "cn") return item.proposed_qty;
  const soldSince = Math.max(0, item.current_qty - liveQty);
  return Math.max(0, item.proposed_qty - soldSince);
}
