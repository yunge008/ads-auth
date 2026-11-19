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
  /** 海外仓补货目标天数：低于预警天数（min_days）的 listing 补到这么多天的销量 */
  target_days: number;
};

export const DEFAULT_PARAMS: Params = {
  window_days: 14,
  min_days: 10,
  min_qty: 5,
  reserve_per_sku: 5,
  zero_sale_qty: 5,
  cn_min_days: 10,
  cn_target_days: 20,
  target_days: 30,
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
 * 最少改动分配（负责人 2026-11-18）：不按比例平均，只动必须动的 listing。
 *   预警：listing 可售天数 < min_days（预警天数）或 数量 < min_qty → 需要补；全部 ≥ 预警天数 → 一个都不动。
 *   补到：target_days 天销量（无销量的补到 zero_sale_qty）。
 *   来源顺序：① 仓库未分配（可分配 − 当前各 listing 合计）；② 从可售天数最多的 listing 调出，调出后对方仍 ≥ 目标天数；
 *            ③ 仍不够，从对方「高于预警天数」的部分调出（对方调后 ≥ 预警天数）。调出时优先同一个 listing（减少改动条数）。
 *   超卖：某单品被占用合计 > 可分配 → 从可售天数最多的 listing 逐件减回。
 *   组合款（多单品）一套占用各单品各 q 件；调出组合款同时释放它的所有单品。
 */
export function planCluster(w: Warehouse, cs: Consumer[], stock: Map<string, number>, p: Params): { items: PlanItem[]; group: GroupStatus } {
  const skus = [...new Set(cs.flatMap((c) => [...c.comps.keys()]))].sort();
  const pool = new Map(skus.map((k) => [k, Math.max(0, (stock.get(k) ?? 0) - p.reserve_per_sku)]));
  const isCombo = (c: Consumer) => c.comps.size > 1 || [...c.comps.values()][0] > 1 || !c.comps.has(c.whSku);
  const cap = (c: Consumer, m: Map<string, number>) => Math.min(...[...c.comps].map(([k, q]) => Math.floor((m.get(k) ?? 0) / q)));
  const label = skus.join("+");
  const hasCombo = cs.some(isCombo);

  const cur = new Map<Consumer, number>(cs.map((c) => [c, c.slot.qty]));
  const used = new Map(skus.map((k) => [k, 0]));
  for (const c of cs) for (const [k, q] of c.comps) used.set(k, used.get(k)! + cur.get(c)! * q);
  const free = (k: string) => pool.get(k)! - used.get(k)!;
  const move = (c: Consumer, n: number) => { cur.set(c, cur.get(c)! + n); for (const [k, q] of c.comps) used.set(k, used.get(k)! + n * q); };
  const days = (c: Consumer, q = cur.get(c)!) => (c.daily > 0 ? q / c.daily : q > 0 ? Infinity : 0);
  const keepAt = (c: Consumer, d: number) => (c.daily > 0 ? Math.ceil(c.daily * d) : Math.min(c.slot.qty, p.zero_sale_qty));
  const isLow = (c: Consumer) => c.slot.virtual ? cap(c, pool) > 0 : (c.slot.qty < p.min_qty || (c.daily > 0 && c.slot.qty / c.daily < p.min_days));
  const want = (c: Consumer) => (c.daily > 0 ? Math.ceil(c.daily * p.target_days) : p.zero_sale_qty);

  const lows = cs.filter(isLow);
  const overSold = skus.some((k) => free(k) < 0);
  const group: GroupStatus = {
    warehouse_code: w.code, wh_sku: label, wh_available: Math.min(...skus.map((k) => stock.get(k) ?? 0)), pool: Math.min(...skus.map((k) => pool.get(k)!)),
    slots: cs.length, triggered: lows.length > 0 || overSold,
    note: (hasCombo ? `含单品组套（单品 ${skus.join("、")}）：` : "") + (overSold ? "listing 合计超过仓库可分配，需调减" : lows.length ? `${lows.length} 个 listing 低于预警` : "全部 ≥ 预警天数，无需调整"),
  };
  if (!lows.length && !overSold) return { items: [], group };

  const lowSet = new Set(lows);
  const fromOthers = new Map<Consumer, number>(), gaveTo = new Map<Consumer, number>();
  const add = (m: Map<Consumer, number>, c: Consumer, n: number) => m.set(c, (m.get(c) ?? 0) + n);
  let guard = 0;

  // 超卖：从可售天数最多的逐件减
  for (const k of skus) {
    while (free(k) < 0 && guard++ < 200_000) {
      const donors = cs.filter((c) => c.comps.has(k) && cur.get(c)! > 0);
      if (!donors.length) break;
      donors.sort((a, b) => days(b) - days(a) || cur.get(b)! - cur.get(a)!);
      move(donors[0], -1);
    }
  }
  // 低于预警的补货：每次给「当前可售天数最低」的那个补 1 件（库存不够时大家天数尽量拉平）
  const blocked = new Set<Consumer>();
  const tryAddOne = (c: Consumer): boolean => {
    const log: Consumer[] = [];
    const undo = () => { for (const d of log) { move(d, 1); add(gaveTo, d, -1); if (!gaveTo.get(d)) gaveTo.delete(d); add(fromOthers, c, -1); } return false; };
    for (const [k, q] of c.comps) {
      while (free(k) < q) {
        // ② 从可售天数最多的调出、对方保持 ≥ 目标天数；③ 再从对方高于预警的部分调出，且对方调后天数仍高于被补方
        const pick = (floorDays: number, mustBeAbove: boolean) => cs.filter((d) => d !== c && !lowSet.has(d) && d.comps.has(k)
            && cur.get(d)! > keepAt(d, floorDays) && (!mustBeAbove || days(d, cur.get(d)! - 1) > days(c, cur.get(c)! + 1)))
          .sort((a, b) => (gaveTo.has(b) ? 1 : 0) - (gaveTo.has(a) ? 1 : 0) || days(b) - days(a))[0];
        const donor = pick(p.target_days, false) ?? pick(p.min_days, true);
        if (!donor) return undo(); // 组合款某个单品凑不齐：已调出的退回，不白改别人
        move(donor, -1);
        log.push(donor);
        add(gaveTo, donor, 1);
        add(fromOthers, c, 1);
      }
    }
    move(c, 1);
    return true;
  };
  while (guard++ < 200_000) {
    const open = lows.filter((c) => !blocked.has(c) && cur.get(c)! < want(c));
    if (!open.length) break;
    open.sort((a, b) => days(a) - days(b) || b.daily - a.daily);
    if (!tryAddOne(open[0])) blocked.add(open[0]);
  }

  const items: PlanItem[] = [];
  for (const c of cs) {
    const s = c.slot;
    const t = cur.get(c)!;
    if (t === s.qty || (s.virtual && t === 0)) continue;
    const combo = isCombo(c);
    const compText = [...c.comps].map(([k, q]) => (q > 1 ? `${k}×${q}` : k)).join(" + ");
    const warnings: string[] = [];
    if (t === 0) warnings.push("目标为 0：官方文档写 quantity 范围 1–99,999，设 0 未实测，可能需改为解除仓库关联");
    if (w.status === "phasing_out") warnings.push("旧仓逐步退出中");
    if (lowSet.has(c) && t < want(c)) warnings.push(`仓库可分配不足，只能补到 ${t} 件（目标 ${want(c)} 件），建议补货`);
    if (combo) warnings.push("单品组套：ERP 需有该组合映射才能发货");
    const before = daysOf(s.qty, c.daily);
    const after = daysOf(t, c.daily);
    const took = fromOthers.get(c) ?? 0;
    const why = s.virtual ? `新仓首次设置库存（listing 尚未关联 ${w.name}）`
      : lowSet.has(c)
      ? `${before !== null ? `可售 ${r1(before)} 天` : `当前 ${s.qty} 件`} < 预警 ${c.daily > 0 ? `${p.min_days} 天` : `${p.min_qty} 件`}，补到 ${t} 件` +
        `（仓库未分配 ${Math.max(0, t - s.qty - took)} 件${took ? `、从其他 listing 调入 ${took} 件` : ""}）` + (combo ? `；单品组套 ${compText}` : "")
      : gaveTo.has(c)
      ? `调出 ${s.qty - t} 件给同 SKU 可售不足的 listing，调后仍可售 ${after === null ? "—" : r1(after)} 天`
      : `listing 合计超过仓库可分配，从可售天数最多的调减 ${s.qty - t} 件`;
    items.push({
      kind: "overseas", warehouse_code: w.code, wh_sku: c.whSku, shop_id: s.shop_id, region: s.region,
      product_id: s.product_id, sku_id: s.sku_id, seller_sku: s.seller_sku, title: s.title, tts_warehouse_id: s.tts_warehouse_id,
      current_qty: s.qty, proposed_qty: t, daily_sales: Math.round(c.daily * 100) / 100,
      days_before: r1(before), days_after: r1(after),
      wh_available: combo ? cap(c, stock) : stock.get(c.whSku) ?? 0, pool: combo ? cap(c, pool) : pool.get(c.whSku)!,
      reason: why, warnings, new_link: !!s.virtual,
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
      const r = planCluster(w, g.map((s) => ({ slot: s, whSku, comps: new Map([[whSku, 1]]), daily: dailyOf(s) })), stockMap!, p);
      items.push(...r.items);
      groups.push(r.group);
    };

    // 分类：仓库有同名 SKU → 实物；否则按「+」拆成单品，全部单品在仓库有库存 → 组合（临时组合，按单品库存分配）；其余 → 找不到
    const physical = new Map<string, Slot[]>();
    const combos = new Map<string, { comps: Map<string, number>; slots: Slot[] }>();
    for (const [whSku, g] of byWhSku) {
      const comps = parseCombo(whSku);
      const hasPhysical = !!stockMap?.has(whSku);
      // 有现成预组装实物（可用 − 预留 > 0）→ 只按实物，不叠加单品；实物没货 → 直接用单品组套（ERP 没映射会报错，由同事处理；负责人 2026-11-18）
      if (hasPhysical && (!comps || stockMap!.get(whSku)! - p.reserve_per_sku > 0)) { physical.set(whSku, g); continue; }
      const real = g.filter((s) => !s.virtual);
      if (comps) {
        const miss = [...comps.keys()].filter((k) => !stockMap?.has(k));
        if (!miss.length) { combos.set(whSku, { comps, slots: g }); continue; }
        if (hasPhysical) { physical.set(whSku, g); continue; } // 实物为 0 且单品凑不齐 → 按实物（会压到 0 并提示）
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

/**
 * 国内仓：不绑定、不导入库存、不改库存，只预警（负责人 2026-11-19）。
 * 同步过的店铺里，没有绑定到任何海外仓（不论海外仓状态）的 TikTok 仓库都视为国内仓。
 * 可售天数 < cn_min_days 的列入预警，建议 TikTok 库存补到 cn_target_days 天销量，由人工确认国内仓有货 / 及时采购后手动改。
 */
export function planCn(warehouses: Warehouse[], slots: Slot[], p: Params): PlanItem[] {
  const cnCode = warehouses.find((w) => w.kind === "cn")?.code ?? "CN";
  const bound = new Set(warehouses.filter((w) => w.kind === "overseas").flatMap((w) => w.links.map((l) => `${l.shop_id}|${l.tts_warehouse_id}`)));
  const items: PlanItem[] = [];
  for (const s of slots) {
    if (s.virtual || bound.has(`${s.shop_id}|${s.tts_warehouse_id}`)) continue;
    const daily = s.sold / p.window_days;
    const before = daysOf(s.qty, daily);
    if (before === null || before >= p.cn_min_days) continue;
    const target = Math.min(99_999, Math.ceil(daily * p.cn_target_days));
    items.push({
      kind: "cn", warehouse_code: cnCode, wh_sku: normSku(s.seller_sku), shop_id: s.shop_id, region: s.region,
      product_id: s.product_id, sku_id: s.sku_id, seller_sku: s.seller_sku, title: s.title, tts_warehouse_id: s.tts_warehouse_id,
      current_qty: s.qty, proposed_qty: Math.max(target, s.qty), daily_sales: Math.round(daily * 100) / 100,
      days_before: r1(before), days_after: r1(daysOf(Math.max(target, s.qty), daily)), wh_available: null, pool: null,
      reason: `国内仓预警：可售 ${r1(before)} 天 < ${p.cn_min_days} 天，建议 TikTok 库存补到 ${Math.max(target, s.qty)} 件（${p.cn_target_days} 天销量）`,
      warnings: ["仅预警，系统不改库存：确认国内仓有货（不足及时采购）后人工修改"], new_link: false,
    });
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

// ── 每日销量（sea_inv_sales_daily：店铺 × SKU ID × 仓库 × 店铺本地日期）──────────────────
// 2026-11-18 负责人：不要每次重拉整个窗口的订单；云端存近 60 天按 SKU ID 的日销量，每次只补拉最近几天。

/** 站点 → UTC 偏移（小时），与 tts-export 一致 */
export const REGION_UTC_OFFSET: Record<string, number> = { PH: 8, MY: 8, SG: 8, TH: 7, VN: 7, ID: 7, JP: 9, GB: 0, US: -8, MX: -6, BR: -3 };
export const SALES_KEEP_DAYS = 60;
export const SALES_OVERLAP_DAYS = 2; // 每次重拉上次同步日往前 2 天（补订单取消、延迟入单）

/** 秒级时间戳 → 店铺本地日期 YYYY-MM-DD */
export function localDay(tsSec: number, offsetH: number): string {
  return new Date((tsSec + offsetH * 3600) * 1000).toISOString().slice(0, 10);
}
/** 本地日期 0 点 → 秒级时间戳 */
export function dayStartSec(day: string, offsetH: number): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000 - offsetH * 3600;
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}
/**
 * 本次要（重）拉订单的起始日：首次 = 今天往前 60 天（初始化）；
 * 之后 = 上次同步日 − 2 天（不早于 60 天前）。终点永远是今天（今天的数据不完整，下次会重拉）。
 */
export function salesPullStart(today: string, lastSyncedDay: string | null): string {
  const floor = addDays(today, -SALES_KEEP_DAYS);
  if (!lastSyncedDay) return floor;
  const s = addDays(lastSyncedDay, -SALES_OVERLAP_DAYS);
  return s < floor ? floor : s;
}
/**
 * 窗口销量：最近 windowDays 个**完整**自然日（昨天往前），按 `${sku_id}|${warehouse_id}` 合计。
 * 不含今天（今天不完整会把日均拉低）。
 */
export function windowSold(rows: Array<{ sku_id: string; warehouse_id: string; day: string; units: number }>, today: string, windowDays: number): Map<string, number> {
  const from = addDays(today, -windowDays), to = addDays(today, -1);
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    const k = `${r.sku_id}|${r.warehouse_id ?? ""}`;
    out.set(k, (out.get(k) ?? 0) + Number(r.units));
  }
  return out;
}
