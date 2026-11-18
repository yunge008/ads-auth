// 海外仓库存 Excel / CSV 解析（RPA 导出到云盘的文件、页面上传同口径）。
// 列名优先用仓库配置 file_config 指定的表头（不区分大小写、去空格），没配就按常见表头自动识别。
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

export type FileConfig = {
  sheet?: string;           // 指定 sheet 名；空 = 第一个能识别出表头的 sheet
  sku_col?: string;         // SKU 列表头
  avail_col?: string;       // 可用数量列表头
  onhand_col?: string;      // 在库/总量列表头（可选，只展示）
  name_col?: string;        // 商品名称列表头（可选）
  warehouse_col?: string;   // 仓库列表头（文件含多个仓时用）
  warehouse_value?: string; // 只取该仓库（与仓库列完全一致，去首尾空格）
};
export type ParsedRow = { wh_sku: string; available: number; on_hand: number | null; product_name: string | null };
export type ParseResult = { rows: ParsedRow[]; notes: string[]; sheet: string | null; header_row: number | null };

const SKU = /^(sku|商品sku|仓库sku|产品sku|seller\s*sku|商家sku|sku编码|商品sku编码|商品编码|产品编码|编码|商品sku码)$/i;
const AVAIL = /^(可用|可用库存|可用数量|可用量|可用库存数|可售|可售库存|可售数量|可销售库存|available|available\s*(qty|stock|quantity))$/i;
const ONHAND = /^(在库|在库库存|实物库存|总库存|总量|库存|库存总量|on\s*hand|现有库存)$/i;
const NAME = /^(商品名称|名称|品名|产品名称|product\s*name|name|title|商品标题)$/i;

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[,，\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function findCol(row: string[], name: string | undefined, re: RegExp): number {
  if (name) return row.findIndex((c) => norm(c) === norm(name));
  return row.findIndex((c) => re.test(String(c ?? "").trim()));
}

export function parseStockTable(table: unknown[][], cfg: FileConfig = {}): Omit<ParseResult, "sheet"> {
  const notes: string[] = [];
  let hi = -1, cSku = -1, cAv = -1, cOn = -1, cName = -1, cWh = -1;
  for (let i = 0; i < Math.min(20, table.length); i++) {
    const row = (table[i] ?? []).map((c) => String(c ?? "").trim());
    const s = findCol(row, cfg.sku_col, SKU);
    const a = findCol(row, cfg.avail_col, AVAIL);
    if (s >= 0 && a >= 0) {
      hi = i; cSku = s; cAv = a;
      cOn = findCol(row, cfg.onhand_col, ONHAND);
      cName = findCol(row, cfg.name_col, NAME);
      cWh = cfg.warehouse_col ? findCol(row, cfg.warehouse_col, /$^/) : -1;
      break;
    }
  }
  if (hi < 0) {
    const want = `${cfg.sku_col ? `「${cfg.sku_col}」` : "SKU"} 和 ${cfg.avail_col ? `「${cfg.avail_col}」` : "可用库存"}`;
    return { rows: [], notes: [`前 20 行找不到表头（需要 ${want} 两列）`], header_row: null };
  }
  if (hi > 0) notes.push(`表头在第 ${hi + 1} 行，上面 ${hi} 行已忽略`);
  if (cfg.warehouse_col && cWh < 0) notes.push(`找不到仓库列「${cfg.warehouse_col}」，未按仓库过滤`);
  const wantWh = (cfg.warehouse_value ?? "").trim();
  const map = new Map<string, ParsedRow>();
  let skipped = 0, otherWh = 0, dup = 0, neg = 0;
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i] ?? [];
    const sku = String(r[cSku] ?? "").trim();
    const av = num(r[cAv]);
    if (!sku && av === null) continue;
    if (!sku || av === null) { skipped++; continue; }
    if (cWh >= 0 && wantWh && String(r[cWh] ?? "").trim() !== wantWh) { otherWh++; continue; }
    if (av < 0) neg++;
    const on = cOn >= 0 ? num(r[cOn]) : null;
    const prev = map.get(sku);
    if (prev) {
      dup++;
      prev.available += Math.max(0, Math.trunc(av));
      prev.on_hand = prev.on_hand === null && on === null ? null : (prev.on_hand ?? 0) + Math.trunc(on ?? 0);
    } else {
      map.set(sku, { wh_sku: sku, available: Math.max(0, Math.trunc(av)), on_hand: on === null ? null : Math.trunc(on), product_name: cName >= 0 ? String(r[cName] ?? "").trim() || null : null });
    }
  }
  if (skipped) notes.push(`${skipped} 行 SKU 为空或可用数量不是数字，已跳过`);
  if (otherWh) notes.push(`${otherWh} 行属于其他仓库，已跳过`);
  if (dup) notes.push(`${dup} 行 SKU 重复，已按 SKU 合计（如果文件含多个仓，请在配置里填仓库列与仓库名）`);
  if (neg) notes.push(`${neg} 行可用数量为负数，按 0 计`);
  return { rows: [...map.values()], notes, header_row: hi + 1 };
}

export function parseStockWorkbook(bytes: Uint8Array, cfg: FileConfig = {}): ParseResult {
  const wb = XLSX.read(bytes, { type: "array" });
  const names = cfg.sheet ? [cfg.sheet] : wb.SheetNames;
  if (cfg.sheet && !wb.Sheets[cfg.sheet]) return { rows: [], notes: [`文件里没有 sheet「${cfg.sheet}」（有：${wb.SheetNames.join("、")}）`], sheet: null, header_row: null };
  let first: ParseResult | null = null;
  for (const name of names) {
    const table = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    const p = parseStockTable(table, cfg);
    const res = { ...p, sheet: name };
    if (p.header_row !== null) {
      if (wb.SheetNames.length > 1 && !cfg.sheet) res.notes = [`文件有 ${wb.SheetNames.length} 个 sheet，用的是「${name}」`, ...res.notes];
      return res;
    }
    first ??= res;
  }
  return first ?? { rows: [], notes: ["文件没有 sheet"], sheet: null, header_row: null };
}
