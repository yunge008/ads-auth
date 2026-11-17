// TikTok Shop 店铺固定内容导出（前端驱动 Edge Function `tts-export` 的分片续跑），
// 拼成与卖家后台导出同列名 / 同格式的文件，便于沿用已有的分析 skill 和表格。
import * as XLSX from "xlsx";
import { invokeFn } from "@/lib/api";

export type TtsExportKind = "orders" | "finance" | "products" | "affiliate" | "samples";
type Cell = string | number | null;
type Chunk = {
  kind: string;
  columns: string[];
  rows: Cell[][];
  next_cursor: Record<string, unknown> | null;
  progress: { done: number; total: number | null; unit: string };
  meta?: Record<string, unknown>;
  errors: string[];
};
export type ExportProgress = (msg: string) => void;
export type ExportSummary = { files: string[]; rows: number; errors: string[]; notes: string[] };

/** 循环调用直到 next_cursor 为空；收集全部行、首片 meta、错误 */
async function runAll(body: Record<string, unknown>, onProgress?: ExportProgress, label = "") {
  const rows: Cell[][] = [];
  const errors: string[] = [];
  let columns: string[] = [];
  const meta: Record<string, unknown> = {};
  let cursor: Record<string, unknown> | null = null;
  let lastKey = "";
  let calls = 0;
  do {
    const c: Chunk = await invokeFn<Chunk>("tts-export", { ...body, cursor }, { timeout: 150000 });
    calls++;
    columns = c.columns;
    rows.push(...c.rows);
    errors.push(...c.errors);
    for (const [k, v] of Object.entries(c.meta ?? {})) {
      if (k === "attr_names" && meta[k]) Object.assign(meta[k] as Record<string, string>, v as Record<string, string>);
      else if (!(k in meta)) meta[k] = v;
    }
    cursor = c.next_cursor;
    const key = JSON.stringify(cursor);
    if (cursor && key === lastKey) throw new Error("导出分片没有推进，已停止");
    lastKey = key;
    const p = c.progress;
    onProgress?.(`${label}已处理 ${p.done.toLocaleString()}${p.total != null ? ` / ${p.total.toLocaleString()}` : ""} ${p.unit}，累计 ${rows.length.toLocaleString()} 行（第 ${calls} 片）`);
  } while (cursor);
  return { rows, columns, meta, errors };
}

// ID 列一律文本：19 位 ID 转成数字会被 Excel 截成科学计数法
const isIdCol = (c: string) => /(^|[^a-z])id$|ID|Id\b|_id$|^sku_id$|^product_id$/.test(c) && !/Paid|Sku Quantity/.test(c);
function xcell(col: string, v: Cell): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  if (isIdCol(col)) return v;
  return v;
}
function writeXlsx(fileName: string, sheets: Array<{ name: string; aoa: (string | number)[][] }>) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.name);
  XLSX.writeFile(wb, fileName);
}
function csvCell(v: Cell): string {
  const raw = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}
function writeCsv(fileName: string, columns: string[], rows: Cell[][]) {
  // 后台订单 CSV 的 ID / 时间列末尾带 \t 防止 Excel 转科学计数法；这里同样处理 ID 列
  const body = rows.map((r) => r.map((v, i) => csvCell(isIdCol(columns[i]) && v ? `${v}\t` : v)).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`﻿${columns.join(",")}\r\n${body}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
    if (out.length > 24) throw new Error("一次最多导出 24 个月");
  }
  return out;
}

/** 月度订单：每个月一个 CSV（与后台「订单导出」同列） */
async function exportOrders(shop: { shop_id: string; region: string }, fromMonth: string, toMonth: string, onProgress?: ExportProgress): Promise<ExportSummary> {
  const s: ExportSummary = { files: [], rows: 0, errors: [], notes: [] };
  for (const month of monthsBetween(fromMonth, toMonth)) {
    const r = await runAll({ kind: "orders", shop_id: shop.shop_id, month }, onProgress, `${month} 订单：`);
    const name = `${shop.region}_订单_${month}.csv`;
    writeCsv(name, r.columns, r.rows);
    s.files.push(name); s.rows += r.rows.length; s.errors.push(...r.errors.map((e) => `${month}: ${e}`));
  }
  s.notes.push("买家个人信息（用户名/收件人/电话/详细地址）不导出；退货件数/退款金额/Return/Refund 来自退货退款接口，仓库名称来自仓库列表（口径待与后台导出核对）；Weight、Product Category、Order Channel、Creator Handle、Checked Status 接口不提供，留空");
  return s;
}

/** 月度财务：一个 xlsx，含「订单详情」「对账单」两个页签 */
async function exportFinance(shop: { shop_id: string; region: string }, fromMonth: string, toMonth: string, onProgress?: ExportProgress): Promise<ExportSummary> {
  const s: ExportSummary = { files: [], rows: 0, errors: [], notes: [] };
  for (const month of monthsBetween(fromMonth, toMonth)) {
    const r = await runAll({ kind: "finance", shop_id: shop.shop_id, month }, onProgress, `${month} 结算：`);
    const stmts = (r.meta.statements as Cell[][] | undefined) ?? [];
    const stmtCols = (r.meta.statement_columns as string[] | undefined) ?? [];
    // 明细合计 vs 对账单表头逐张核对
    const sum = new Map<string, number>();
    const sidIdx = r.columns.indexOf("结算单 ID"), amtIdx = r.columns.indexOf("结算总金额");
    for (const row of r.rows) sum.set(String(row[sidIdx]), (sum.get(String(row[sidIdx])) ?? 0) + Math.round(Number(row[amtIdx] ?? 0) * 100));
    const bad = stmts.filter((st) => Math.round(Number(st[2] ?? 0) * 100) !== (sum.get(String(st[1])) ?? 0));
    if (bad.length) s.errors.push(`${month}: ${bad.length} 张结算单明细合计 ≠ 表头结算金额（${bad.slice(0, 3).map((b) => b[1]).join(", ")}）`);
    const name = `${shop.region}_财务结算_${month}.xlsx`;
    writeXlsx(name, [
      { name: "订单详情", aoa: [r.columns, ...r.rows.map((row) => row.map((v, i) => xcell(r.columns[i], v)))] },
      { name: "对账单", aoa: [stmtCols, ...stmts.map((row) => row.map((v, i) => xcell(stmtCols[i], v)))] },
    ]);
    s.files.push(name); s.rows += r.rows.length; s.errors.push(...r.errors.map((e) => `${month}: ${e}`));
  }
  s.notes.push("按结算单生成时间归月；一行一笔交易（订单维度），SKU ID/数量/商品名称留空；api.* 列为接口原始分项。费用列映射未全部核验，需与后台导出对一次");
  return s;
}

/** 最新商品：后台「批量编辑-全部信息」模板格式（前 5 行表头，第 6 行起数据），最右加「活动价」 */
async function exportProducts(shop: { shop_id: string; region: string }, activityId: string, onProgress?: ExportProgress): Promise<ExportSummary> {
  const s: ExportSummary = { files: [], rows: 0, errors: [], notes: [] };
  const r = await runAll({ kind: "products", shop_id: shop.shop_id, activity_id: activityId }, onProgress, "商品：");
  const fixedKeys = r.columns.slice(0, r.columns.indexOf("__attrs"));
  const fixedLabels = (r.meta.fixed_labels as string[] | undefined) ?? fixedKeys;
  const attrNames = (r.meta.attr_names as Record<string, string> | undefined) ?? {};
  const attrKeys = Object.keys(attrNames).sort().map((id) => `product_property/${id}`);
  const aoa: (string | number)[][] = [
    [...fixedKeys, ...attrKeys, "activity_price"],
    ["V4", "All_Information", "metric"],
    [...fixedLabels, ...attrKeys.map((k) => attrNames[k.split("/")[1]] ?? k), "活动价"],
    [],
    [],
  ];
  let withPrice = 0;
  for (const row of r.rows) {
    const attrs = JSON.parse(String(row[fixedKeys.length] ?? "{}")) as Record<string, string>;
    const act = row[fixedKeys.length + 1];
    if (act !== null && act !== undefined) withPrice++;
    aoa.push([...fixedKeys.map((k, i) => xcell(k, row[i])), ...attrKeys.map((k) => attrs[k] ?? ""), act ?? ""]);
  }
  const name = `${shop.region}_商品信息_${new Date().toISOString().slice(0, 10)}.xlsx`;
  writeXlsx(name, [{ name: "Template", aoa }]);
  s.files.push(name); s.rows = r.rows.length; s.errors.push(...r.errors);
  s.notes.push(`活动 ${String(r.meta.activity_id || "（未填）")}「${String(r.meta.activity_title ?? "")}」含 ${String(r.meta.activity_sku_count ?? 0)} 个 SKU 价格；本次 ${r.rows.length} 个 SKU 中 ${withPrice} 个匹配到活动价`);
  return s;
}

/** 月度联盟订单：拆成「达人」「服务商」两个 xlsx（与后台两个页签导出同列） */
async function exportAffiliate(shop: { shop_id: string; region: string }, fromMonth: string, toMonth: string, onProgress?: ExportProgress): Promise<ExportSummary> {
  const s: ExportSummary = { files: [], rows: 0, errors: [], notes: [] };
  for (const month of monthsBetween(fromMonth, toMonth)) {
    const r = await runAll({ kind: "affiliate", shop_id: shop.shop_id, month }, onProgress, `${month} 联盟订单：`);
    const cc = r.meta.creator_columns as string[], pc = r.meta.partner_columns as string[];
    const creators = r.rows.filter((x) => x[0] === "creator").map((x) => x.slice(1));
    const partners = r.rows.filter((x) => x[0] === "partner").map((x) => x.slice(1));
    const n1 = `${shop.region}_联盟订单_达人_${month}.xlsx`, n2 = `${shop.region}_联盟订单_服务商_${month}.xlsx`;
    writeXlsx(n1, [{ name: "Sheet1", aoa: [cc, ...creators.map((row) => row.map((v, i) => xcell(cc[i], v)))] }]);
    writeXlsx(n2, [{ name: "Sheet1", aoa: [
      ["Note: 由接口导出。联盟团长ID/名称、PIT、佣金结算时间、平台 接口不提供，留空。"], pc, ...partners.map((row) => row.map((v, i) => xcell(pc[i], v))),
    ] }]);
    s.files.push(n1, n2); s.rows += r.rows.length; s.errors.push(...r.errors.map((e) => `${month}: ${e}`));
  }
  s.notes.push("按下单时间归月（后台页签可能按其他时间筛选，条数可能不同）；有服务商活动 ID 或服务商佣金率的 SKU 归入服务商表");
  return s;
}

/** 待审申样 + 审核建议（只读） */
async function exportSamples(shop: { shop_id: string; region: string }, onProgress?: ExportProgress): Promise<ExportSummary> {
  const r = await runAll({ kind: "samples", shop_id: shop.shop_id }, onProgress, "申样：");
  const name = `${shop.region}_申样审核建议_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const th = r.meta.thresholds as Record<string, number> | undefined;
  writeXlsx(name, [
    { name: "审核建议", aoa: [r.columns, ...r.rows.map((row) => row.map((v, i) => xcell(r.columns[i], v)))] },
    { name: "规则", aoa: [["参数", "值"], ...Object.entries(th ?? {}).map(([k, v]) => [k, v])] },
  ]);
  const count = (a: string) => r.rows.filter((x) => x[0] === a).length;
  return {
    files: [name], rows: r.rows.length, errors: r.errors,
    notes: [`推荐批准 ${count("推荐批准")} / 待审核 ${count("待审核")} / 不批准 ${count("不批准")}；只给建议，不会调用审样接口`],
  };
}

export async function runTtsExport(
  kind: TtsExportKind,
  shop: { shop_id: string; region: string },
  opts: { fromMonth?: string; toMonth?: string; activityId?: string },
  onProgress?: ExportProgress,
): Promise<ExportSummary> {
  const from = opts.fromMonth ?? "", to = opts.toMonth || from;
  if (kind === "samples") return exportSamples(shop, onProgress);
  if (kind !== "products" && (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to)) throw new Error("请选择有效的起止月份");
  if (kind === "orders") return exportOrders(shop, from, to, onProgress);
  if (kind === "finance") return exportFinance(shop, from, to, onProgress);
  if (kind === "affiliate") return exportAffiliate(shop, from, to, onProgress);
  return exportProducts(shop, opts.activityId ?? "", onProgress);
}
