// SEA库存监控：批量上传海外仓库存表（BigSeller / 顶妙 TOPWMS / 千易 导出），浏览器内解析。
//
// 已对照 2026-11-18 四份真实导出：
//   BigSeller   sheet「单个SKU」「组合SKU」，列 SKU编号 / 仓库 / 现有库存 / 订单已锁 / 整仓可用 / 活动预留 / SKU类型；
//               整仓可用 = 现有库存 − 订单已锁 − 活动预留（单品全部成立）。
//               组合SKU 的库存是由单品推算的虚拟数（如 AR108+ B4 = min(AR108, B4)），与单品共用同一批实物，
//               一起导入会重复计算 → 跳过组合 SKU（SKU类型 = Combination SKU 或 sheet 名含「组合」）；
//               组合款 listing 在生成计划时按「+」拆成单品、用单品库存分配（_shared/sea-inventory.ts planCluster）。
//   顶妙 TOPWMS sheet「WorkSheet」，列 商品SKU / 预占库存 / 可用库存 / 仓库（GOGO云仓）；与 API 逐 SKU 一致。
//   千易        sheet「Sheet1」两行表头（第 1 行分组、第 2 行列名），列 商品编码 / 仓库 / 可用量 / 在库量；MY、PH 两个仓在同一个文件。
import * as XLSX from "xlsx";

export type UpRow = { wh_sku: string; available: number; on_hand: number | null; product_name: string | null };
export type UpGroup = {
  key: string;
  file: string;
  sheet: string;
  whValue: string | null;      // 文件「仓库」列的值（没有仓库列为 null）
  rows: UpRow[];
  notes: string[];
  combosSkipped: number;
  exportTime: string | null;   // 从文件名解析的导出时间（ISO），解析不出为 null
};

const SKU = /^(sku|sku编号|商品sku|仓库sku|产品sku|seller\s*sku|商家sku|sku编码|商品sku编码|商品编码|产品编码|编码)$/i;
const AVAIL = /^(整仓可用|可用|可用库存|可用数量|可用量|可用库存数|可售|可售库存|可售数量|available|available\s*(qty|stock|quantity))$/i;
const ONHAND = /^(现有库存|在库量|在库|在库库存|实物库存|总库存|库存总量|on\s*hand)$/i;
const NAME = /^(商品名称|名称|品名|产品名称|product\s*name|name)$/i;
const WH = /^(仓库|仓库名称|warehouse)$/i;
const TYPE = /^(sku类型|商品类型)$/i;

const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[,，\s]/g, "");
  if (s === "" || s === "-" || s === "--") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 文件名里的 14~17 位时间戳（BigSeller：…20261118103131565.xlsx）→ 北京时间 ISO；超出 7 天或晚于现在则不用 */
export function exportTimeFromName(name: string, now = Date.now()): string | null {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
  if (!Number.isFinite(t) || t > now + 10 * 60_000 || t < now - 7 * 86400_000) return null;
  return new Date(t).toISOString();
}

export function parseSheetTable(table: unknown[][], file: string, sheet: string, includeCombo: boolean): UpGroup[] {
  let hi = -1;
  let c = { sku: -1, av: -1, on: -1, name: -1, wh: -1, type: -1 };
  for (let i = 0; i < Math.min(10, table.length); i++) {
    const row = (table[i] ?? []).map((x) => String(x ?? "").trim());
    const sku = row.findIndex((x) => SKU.test(x));
    const av = row.findIndex((x) => AVAIL.test(x));
    if (sku >= 0 && av >= 0) {
      hi = i;
      c = { sku, av, on: row.findIndex((x) => ONHAND.test(x)), name: row.findIndex((x) => NAME.test(x)), wh: row.findIndex((x) => WH.test(x)), type: row.findIndex((x) => TYPE.test(x)) };
      break;
    }
  }
  const exportTime = exportTimeFromName(file);
  if (hi < 0) {
    return [{ key: `${file}|${sheet}|`, file, sheet, whValue: null, rows: [], notes: ["前 10 行找不到表头（需要 SKU 列和可用库存列）"], combosSkipped: 0, exportTime }];
  }
  const comboSheet = /组合|combo/i.test(sheet);
  const groups = new Map<string, { rows: Map<string, UpRow>; dup: number; bad: number; neg: number; combos: number }>();
  const g = (wh: string) => {
    if (!groups.has(wh)) groups.set(wh, { rows: new Map(), dup: 0, bad: 0, neg: 0, combos: 0 });
    return groups.get(wh)!;
  };
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i] ?? [];
    const sku = String(r[c.sku] ?? "").trim();
    const av = num(r[c.av]);
    if (!sku && av === null) continue;
    const wh = c.wh >= 0 ? String(r[c.wh] ?? "").trim() : "";
    const grp = g(wh);
    const isCombo = comboSheet || (c.type >= 0 && /combination|组合/i.test(String(r[c.type] ?? "")));
    if (isCombo && !includeCombo) { grp.combos++; continue; }
    if (!sku || av === null) { grp.bad++; continue; }
    if (av < 0) grp.neg++;
    const on = c.on >= 0 ? num(r[c.on]) : null;
    const prev = grp.rows.get(sku);
    if (prev) {
      grp.dup++;
      prev.available += Math.max(0, Math.trunc(av));
      prev.on_hand = prev.on_hand === null && on === null ? null : (prev.on_hand ?? 0) + Math.trunc(on ?? 0);
    } else {
      grp.rows.set(sku, { wh_sku: sku, available: Math.max(0, Math.trunc(av)), on_hand: on === null ? null : Math.trunc(on), product_name: c.name >= 0 ? String(r[c.name] ?? "").trim() || null : null });
    }
  }
  if (!groups.size) groups.set("", { rows: new Map(), dup: 0, bad: 0, neg: 0, combos: 0 });
  return [...groups.entries()].map(([wh, x]) => {
    const notes: string[] = [];
    if (hi > 0) notes.push(`表头在第 ${hi + 1} 行`);
    if (x.combos) notes.push(`跳过 ${x.combos} 个组合 SKU（BigSeller 组合库存由单品推算；组合款 listing 生成计划时按单品库存分配）`);
    if (x.bad) notes.push(`${x.bad} 行 SKU 为空或可用数量不是数字，已跳过`);
    if (x.dup) notes.push(`${x.dup} 行 SKU 重复，已合计`);
    if (x.neg) notes.push(`${x.neg} 行可用为负数，按 0 计`);
    if (!exportTime) notes.push("文件名里没有导出时间，库存时间按导入时刻计");
    return { key: `${file}|${sheet}|${wh}`, file, sheet, whValue: c.wh >= 0 ? wh : null, rows: [...x.rows.values()], notes, combosSkipped: x.combos, exportTime };
  });
}

export async function parseUploadFile(file: File, includeCombo: boolean): Promise<UpGroup[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  return parseWorkbook(wb, file.name, includeCombo);
}

export function parseWorkbook(wb: XLSX.WorkBook, fileName: string, includeCombo: boolean): UpGroup[] {
  const out: UpGroup[] = [];
  for (const sheet of wb.SheetNames) {
    // 有些导出文件的 dimension 元数据是错的（只标 A1），按实际单元格重算范围
    const ws = wb.Sheets[sheet];
    const cells = Object.keys(ws).filter((k) => !k.startsWith("!"));
    if (cells.length) {
      const range = cells.reduce((acc, k) => {
        const a = XLSX.utils.decode_cell(k);
        return { s: { r: Math.min(acc.s.r, a.r), c: Math.min(acc.s.c, a.c) }, e: { r: Math.max(acc.e.r, a.r), c: Math.max(acc.e.c, a.c) } };
      }, { s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } });
      ws["!ref"] = XLSX.utils.encode_range(range);
    }
    const table = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
    if (!table.length) continue;
    out.push(...parseSheetTable(table, fileName, sheet, includeCombo));
  }
  return out;
}

/** 文件里的仓库名 → 系统仓库：先比 file_config.warehouse_value，再比 provider_ref、仓库名称（忽略大小写和空格） */
export function matchWarehouse<T extends { code: string; name: string; provider_ref: string | null; file_config: { warehouse_value?: string } | null }>(whValue: string | null, warehouses: T[]): T | null {
  if (!whValue) return null;
  const n = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
  const v = n(whValue);
  return warehouses.find((w) => n(w.file_config?.warehouse_value) === v)
    ?? warehouses.find((w) => w.provider_ref && n(w.provider_ref) === v)
    ?? warehouses.find((w) => n(w.name) === v)
    ?? null;
}
