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
  include_combo?: boolean;  // BigSeller 组合 SKU 库存由单品推算，默认跳过以免重复计算
};
export type ParsedRow = { wh_sku: string; available: number; on_hand: number | null; product_name: string | null };
export type ParseResult = { rows: ParsedRow[]; notes: string[]; sheet: string | null; header_row: number | null };

const SKU = /^(sku|sku编号|商品sku|仓库sku|产品sku|seller\s*sku|商家sku|sku编码|商品sku编码|商品编码|产品编码|编码|商品sku码)$/i;
const AVAIL = /^(整仓可用|可用|可用库存|可用数量|可用量|可用库存数|可售|可售库存|可售数量|可销售库存|available|available\s*(qty|stock|quantity))$/i;
const ONHAND = /^(现有库存|在库量|在库|在库库存|实物库存|总库存|总量|库存|库存总量|on\s*hand)$/i;
const TYPE = /^(sku类型|商品类型)$/i;
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

export function parseStockTable(table: unknown[][], cfg: FileConfig & { sheet_is_combo?: boolean } = {}): Omit<ParseResult, "sheet"> {
  const notes: string[] = [];
  let hi = -1, cSku = -1, cAv = -1, cOn = -1, cName = -1, cWh = -1, cType = -1;
  for (let i = 0; i < Math.min(20, table.length); i++) {
    const row = (table[i] ?? []).map((c) => String(c ?? "").trim());
    const s = findCol(row, cfg.sku_col, SKU);
    const a = findCol(row, cfg.avail_col, AVAIL);
    if (s >= 0 && a >= 0) {
      hi = i; cSku = s; cAv = a;
      cOn = findCol(row, cfg.onhand_col, ONHAND);
      cName = findCol(row, cfg.name_col, NAME);
      cWh = findCol(row, cfg.warehouse_col, /^(仓库|仓库名称|warehouse)$/i);
      cType = findCol(row, undefined, TYPE);
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
  let skipped = 0, otherWh = 0, dup = 0, neg = 0, combos = 0;
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i] ?? [];
    const sku = String(r[cSku] ?? "").trim();
    const av = num(r[cAv]);
    if (!sku && av === null) continue;
    if (!cfg.include_combo && (cfg.sheet_is_combo || (cType >= 0 && /combination|组合/i.test(String(r[cType] ?? ""))))) { combos++; continue; }
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
  if (combos) notes.push(`跳过 ${combos} 个组合 SKU（库存由单品推算，导入会重复计算）`);
  if (skipped) notes.push(`${skipped} 行 SKU 为空或可用数量不是数字，已跳过`);
  if (otherWh) notes.push(`${otherWh} 行属于其他仓库，已跳过`);
  if (dup) notes.push(`${dup} 行 SKU 重复，已按 SKU 合计（如果文件含多个仓，请在配置里填仓库列与仓库名）`);
  if (neg) notes.push(`${neg} 行可用数量为负数，按 0 计`);
  return { rows: [...map.values()], notes, header_row: hi + 1 };
}

export function parseStockWorkbook(bytes: Uint8Array, cfg: FileConfig = {}): ParseResult {
  const wb = XLSX.read(bytes, { type: "array" });
  if (cfg.sheet && !wb.Sheets[cfg.sheet]) return { rows: [], notes: [`文件里没有 sheet「${cfg.sheet}」（有：${wb.SheetNames.join("、")}）`], sheet: null, header_row: null };
  const names = cfg.sheet ? [cfg.sheet] : wb.SheetNames;
  // 所有能识别表头的 sheet 合并（BigSeller 分「单个SKU」「组合SKU」两个 sheet）；组合 sheet 默认整张跳过
  const merged = new Map<string, ParsedRow>();
  const notes: string[] = [];
  const used: string[] = [];
  let header: number | null = null;
  for (const name of names) {
    const ws = wb.Sheets[name];
    // 有些导出文件 dimension 元数据错误（只标 A1），按实际单元格重算范围
    const cells = Object.keys(ws).filter((k) => !k.startsWith("!"));
    if (cells.length) {
      let r0 = Infinity, c0 = Infinity, r1 = 0, c1 = 0;
      for (const k of cells) { const a = XLSX.utils.decode_cell(k); r0 = Math.min(r0, a.r); c0 = Math.min(c0, a.c); r1 = Math.max(r1, a.r); c1 = Math.max(c1, a.c); }
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
    }
    const table = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
    const p = parseStockTable(table, { ...cfg, sheet_is_combo: /组合|combo/i.test(name) });
    if (p.header_row === null) continue;
    header ??= p.header_row;
    used.push(name);
    notes.push(...p.notes.map((n) => `[${name}] ${n}`));
    for (const r of p.rows) {
      const prev = merged.get(r.wh_sku);
      if (prev) { prev.available += r.available; notes.push(`[${name}] SKU ${r.wh_sku} 与其他 sheet 重复，已合计`); }
      else merged.set(r.wh_sku, { ...r });
    }
  }
  if (!used.length) return { rows: [], notes: ["所有 sheet 前 20 行都找不到表头（需要 SKU 列和可用库存列）"], sheet: null, header_row: null };
  return { rows: [...merged.values()], notes, sheet: used.join("、"), header_row: header };
}
