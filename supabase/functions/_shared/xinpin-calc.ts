// 「新品推广」「产品推广计划」两张统计表的纯计算逻辑（不依赖 Deno / 网络，便于本地用 node 对拍）。
//
// 口径与飞书表里原公式一致，只有一处是**变更**（负责人 2026-11-28 定）：
//   新品推广「寄样数量」原公式按行计数不去重；同一达人第一次寄样后，后续返回的素材会复制整行另起一行，
//   寄样列也跟着复制 → 原公式重复计数。现在按「站点 | 发样日期 | SKU 列原文 | 达人用户名」去重。
//   产品推广计划的寄样原公式本来就按「发样日期 | 用户名 | SKU」去重（站点已固定），不变。
// 所有文本比较前统一 TRIM（含不间断空格 CHAR(160)）。

export type Cell = unknown;
export type Row = Cell[];

export function cellStr(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.map((s) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text ?? "") : String(s ?? ""))).join("");
  }
  if (typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
  return String(v);
}

/** TRIM(SUBSTITUTE(x, CHAR(160), " "))：飞书 TRIM 也会把中间连续空格压成一个。 */
export function trimText(v: Cell): string {
  return cellStr(v).replace(/ /g, " ").replace(/ +/g, " ").trim();
}

/** IFERROR(INT(VALUE(x)),0)：日期序列号取整数；文本日期（2026/11/01 等）也按飞书序列号换算。 */
export function dayNum(v: Cell): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  const t = trimText(v);
  if (!t) return 0;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Math.floor(Number(t));
  const m = t.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) {
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(ms)) return Math.round(ms / 86400000) + 25569;
  }
  return 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** REGEXMATCH(TRIM(k), "(^|[^0-9])"&sku&"([^0-9]|$)")，sku 原样（含 "+"）当字面量。 */
export function skuMatcher(sku: string): (k: string) => boolean {
  const re = new RegExp("(^|[^0-9])" + escapeRe(sku) + "([^0-9]|$)");
  return (k) => re.test(k);
}

/** 站点 = s 或以「s-」开头（新品推广）；产品推广计划为精确匹配。 */
function siteOk(area: string, site: string, exact: boolean): boolean {
  return exact ? area === site : area === site || area.startsWith(site + "-");
}

/** 建联表列：B=1 发样日期, C=2 地区, D=3 用户名, K=10 SKU, N=13 视频登记日期, P=15 VID（下标从 A=0 起）。 */
export type BdRow = { area: string; ship: number; user: string; sku: string; reg: number; vid: string };

export function toBdRows(rows: Row[]): BdRow[] {
  const out: BdRow[] = [];
  for (const r of rows) {
    const area = trimText(r?.[2]);
    const sku = trimText(r?.[10]);
    if (!area || !sku) continue; // 两种统计都要求站点匹配 + SKU 匹配，缺一项的行不可能被计入
    out.push({ area, ship: dayNum(r?.[1]), user: trimText(r?.[3]), sku, reg: dayNum(r?.[13]), vid: trimText(r?.[15]) });
  }
  return out;
}

/** 某 BD × 某 SKU × 若干站点 × 日期窗口的寄样数 / 返素材数（均去重）。 */
export function bdCounts(rows: BdRow[], sites: string[], lo: number, hi: number, sku: string, exact: boolean) {
  const match = skuMatcher(sku);
  const ship = sites.map(() => new Set<string>());
  const ret = sites.map(() => new Set<string>());
  for (const r of rows) {
    if (!match(r.sku)) continue;
    sites.forEach((s, i) => {
      if (!siteOk(r.area, s, exact)) return;
      if (r.user && r.ship >= lo && r.ship <= hi) ship[i].add(`${r.area}|${r.ship}|${r.sku}|${r.user}`);
      if (r.vid && r.reg >= lo && r.reg <= hi) ret[i].add(`${r.user}|${r.sku}|${r.vid}`);
    });
  }
  return { ship: ship.map((x) => x.size), ret: ret.map((x) => x.size) };
}

/** 新品推广多站点输出：全为 0 → 0；否则「站点: n」按站点顺序换行拼接（含 0 的站点也列出）。 */
export function siteText(sites: string[], cnts: number[]): string | number {
  if (cnts.reduce((a, b) => a + b, 0) === 0) return 0;
  return sites.map((s, i) => `${s}: ${cnts[i]}`).join("\n");
}

export function splitSites(v: Cell): string[] {
  return cellStr(v).replace(/，/g, ",").split(",").map((x) => trimText(x)).filter((x) => x !== "");
}

/** 剪辑台账（A3:G）：C=日期, D=地区, F=SKU, G=VID。上架日起 30 天内，按(地区,VID)去重后按地区计数，多→少，同数按地区名。 */
export type ClipRow = { day: number; area: string; sku: string; vid: string };
export function toClipRows(rows: Row[]): ClipRow[] {
  const out: ClipRow[] = [];
  for (const r of rows) {
    const area = trimText(r?.[3]);
    const vid = trimText(r?.[6]);
    if (!area || !vid) continue;
    out.push({ day: dayNum(r?.[2]), area, sku: trimText(r?.[5]), vid });
  }
  return out;
}
export function clipText(rows: ClipRow[], start: number, sku: string): string {
  const match = skuMatcher(sku);
  const seen = new Set<string>();
  const cnt = new Map<string, number>();
  for (const r of rows) {
    if (r.day < start || r.day > start + 29 || !match(r.sku)) continue;
    const k = `${r.area}|${r.vid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cnt.set(r.area, (cnt.get(r.area) ?? 0) + 1);
  }
  if (!cnt.size) return "无素材";
  return [...cnt.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([a, n]) => `${a}: ${n}`)
    .join("\n");
}

export function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type CellOut = { cell: string; row: number; col: number; value: string | number };

/**
 * 新品推广：模板 = 原表公式（Formula 渲染）。只填原来有统计公式的单元格：
 *   含 IMPORTRANGE 的列 → 剪辑数（第 2 行剪辑师名 → clips[名]）；
 *   含 "建联-" 的列 → 第 3 行「寄样数量」/「返素材数量」决定口径，BD 名取该对的第一列第 2 行，站点取第二列第 2 行。
 */
export function calcXinpin(
  values: Row[], // 新品推广 A1:S（值）
  formulas: Row[], // 新品推广 A1:S（公式）
  bd: Record<string, BdRow[]>,
  clips: Record<string, ClipRow[]>,
): CellOut[] {
  const row2 = values[1] ?? [];
  const row3 = values[2] ?? [];
  const out: CellOut[] = [];
  const nRows = Math.max(values.length, formulas.length);
  const width = Math.max(row3.length, ...formulas.map((r) => r?.length ?? 0));
  for (let r = 3; r < nRows; r++) {
    const fr = formulas[r] ?? [];
    const vr = values[r] ?? [];
    const start = dayNum(vr[0]);
    const sku = trimText(vr[1]);
    const ok = trimText(vr[0]) !== "" && sku !== "";
    for (let c = 0; c < width; c++) {
      const f = typeof fr[c] === "string" ? (fr[c] as string) : "";
      const label = trimText(row3[c]);
      const isClip = f.includes("IMPORTRANGE") || label === "剪辑素材数量";
      const isBd = f.includes('"建联-"') || label === "寄样数量" || label === "返素材数量";
      if (!isClip && !isBd) continue;
      // 哪些格要填：原来有统计公式的格；公式被脚本换成数值以后，就认「这格已有值」（新加行请整行复制上一行）。
      const hasFormula = f.startsWith("=") && (f.includes("IMPORTRANGE") || f.includes('"建联-"'));
      if (!hasFormula && !(ok && trimText(vr[c]) !== "")) continue;
      const cell = `${colLetter(c)}${r + 1}`;
      if (isClip) {
        const editor = trimText(row2[c]);
        out.push({ cell, row: r + 1, col: c, value: ok ? clipText(clips[editor] ?? [], start, sku) : "" });
        continue;
      }
      const first = label === "寄样数量" ? c : c - 1;
      const name = trimText(row2[first]);
      const sites = splitSites(row2[first + 1]);
      if (!ok || !name || !sites.length) {
        out.push({ cell, row: r + 1, col: c, value: "" });
        continue;
      }
      const res = bdCounts(bd[name] ?? [], sites, start, start + 89, sku, false);
      out.push({ cell, row: r + 1, col: c, value: siteText(sites, label === "寄样数量" ? res.ship : res.ret) });
    }
  }
  return out;
}

/** 新品推广第 2 行：同事名 → 负责站点（如 林乐欣 → [MX, MY]）。 */
export function bdSitesFromXinpin(values: Row[]): Record<string, string[]> {
  const row2 = values[1] ?? [];
  const row3 = values[2] ?? [];
  const out: Record<string, string[]> = {};
  row3.forEach((v, c) => {
    if (trimText(v) === "寄样数量" && trimText(row2[c])) out[trimText(row2[c])] = splitSites(row2[c + 1]);
  });
  return out;
}

/**
 * 产品推广计划：B=开始日期（空=不限）, C=结束日期（空=不限）, D=SKU, G=对应站点（精确匹配）。
 * 只填「负责该站点的同事」那两列（负责人 2026-11-28）：原有 "建联-" 统计公式的格，
 * 或 SKU 非空且 G 站点属于该同事负责站点（bdSites，取自新品推广第 2 行；站点 = s 或以「s-」开头）。输出数字。
 */
export function calcChanpin(values: Row[], formulas: Row[], bd: Record<string, BdRow[]>, bdSites: Record<string, string[]>): CellOut[] {
  const row2 = values[1] ?? [];
  const row3 = values[2] ?? [];
  const out: CellOut[] = [];
  const nRows = Math.max(values.length, formulas.length);
  for (let r = 3; r < nRows; r++) {
    const fr = formulas[r] ?? [];
    const vr = values[r] ?? [];
    const sku = trimText(vr[3]);
    const site = trimText(vr[6]);
    const lo = trimText(vr[1]) === "" ? 1 : dayNum(vr[1]);
    const hi = trimText(vr[2]) === "" ? 1e10 : dayNum(vr[2]);
    for (let c = 0; c < row3.length; c++) {
      const label = trimText(row3[c]);
      if (label !== "寄样数量" && label !== "返素材数量") continue;
      const first = label === "寄样数量" ? c : c - 1;
      const name = trimText(row2[first]);
      const f = typeof fr[c] === "string" ? (fr[c] as string) : "";
      const hasFormula = f.startsWith("=") && f.includes('"建联-"');
      const responsible = !!sku && !!site && (bdSites[name] ?? []).some((s) => site === s || site.startsWith(s + "-"));
      if (!hasFormula && !responsible) continue;
      const cell = `${colLetter(c)}${r + 1}`;
      if (!sku || !name) {
        out.push({ cell, row: r + 1, col: c, value: "" });
        continue;
      }
      const res = bdCounts(bd[name] ?? [], [site], lo, hi, sku, true);
      out.push({ cell, row: r + 1, col: c, value: label === "寄样数量" ? res.ship[0] : res.ret[0] });
    }
  }
  return out;
}

/** 公式值与脚本值是否一致：数字 0 与 "0"、末尾空白一律视为相同。 */
export function sameValue(a: Cell, b: Cell): boolean {
  const norm = (x: Cell) => cellStr(x).replace(/\r\n/g, "\n").trim();
  return norm(a) === norm(b);
}
