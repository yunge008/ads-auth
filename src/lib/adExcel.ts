// TikTok「creative data for product campaigns」导出表解析（中英文表头，26 列）。
// 文件名约定「站点 MAX yyyymm.xlsx」→ 解析出站点（国家）+ 月份。
import * as XLSX from "xlsx";

export type ParsedRow = {
  row_no: number; // Excel 行号（表头为第 1 行）
  campaign_name: string;
  campaign_id: string;
  product_id: string;
  creative_type: string; // 归一化: video | product_card | live | 原文
  video_title: string;
  vid: string; // 'N/A' → ''
  tt_account_name: string; // '-' → ''
  posted_at: string; // '' 或 'YYYY-MM-DD HH:mm'
  status: string;
  authorization_type: string;
  cost: number;
  orders: number;
  gross_revenue: number;
  roi: number | null;
  impressions: number | null;
  clicks: number | null;
  currency: string;
};

/** 单币种小计（gmv/cost 都是该币种原值，未折美元）。 */
export type CurrencyTotal = { currency: string; gmv: number; cost: number; rows: number };

export type ParsedFile = {
  fileName: string;
  country: string | null; // 文件名解析
  month: string | null; // 'YYYY-MM'，文件名解析
  headerLang: "cn" | "en";
  rows: ParsedRow[];
  totals: {
    gmv: number; // 各行 gross_revenue 直接相加；多币种时这个数没有意义，看 byCurrency
    cost: number;
    rows: number;
    productCardRows: number;
    gmvRows: number; // gross_revenue != 0 的行数
    byCurrency: CurrencyTotal[]; // 按行内「货币」列分组，GMV 降序
  };
  /** 解析诊断：这些情况会让 GMV 静默算错，必须显式暴露给用户。 */
  diagnostics: {
    /** 文件里没有「货币」列 —— 所有行会被当成 USD，非美元站点会把 GMV 放大几十倍 */
    missingCurrencyColumn: boolean;
    /** 金额单元格原文非空但转不成数字（币种符号、不换行空格、括号负数…），旧逻辑会静默记 0 */
    badNumberCells: number;
    /** 前几个解析失败的原文样本，便于定位 */
    badNumberSamples: string[];
    /** 表头里没被识别的列（原文），用于发现 TikTok 改了列名 */
    unmappedHeaders: string[];
  };
};

const FILE_RE = /^(.+?)\s*MAX\s*(\d{6})(?:\D[^.]*)?\.xlsx?$/i;

/** 文件名「站点 MAX yyyymm.xlsx」→ { country, month }；不合规返回 null。 */
export function parseFileName(name: string): { country: string; month: string } | null {
  const m = name.trim().match(FILE_RE);
  if (!m) return null;
  const country = m[1].trim();
  const yyyymm = m[2];
  const mo = parseInt(yyyymm.slice(4, 6), 10);
  if (!country || mo < 1 || mo > 12) return null;
  return { country, month: `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}` };
}

// 表头归一化：去所有空白 + 小写（兼容「广告计划 ID」带空格等写法）
function normHeader(h: unknown): string {
  return String(h ?? "").replace(/\s+/g, "").toLowerCase();
}

const HEADER_MAP: Record<string, keyof ParsedRow> = {
  // 中文
  "广告计划名称": "campaign_name",
  "广告计划id": "campaign_id",
  "商品id": "product_id",
  "创意作品类型": "creative_type",
  "视频标题": "video_title",
  "视频id": "vid",
  "tiktok账号": "tt_account_name",
  "发布时间": "posted_at",
  "状态": "status",
  "授权类型": "authorization_type",
  "成本": "cost",
  "sku订单数": "orders",
  "总收入": "gross_revenue",
  "roi": "roi",
  "商品广告曝光数": "impressions",
  "商品广告点击数": "clicks",
  "货币": "currency",
  // 英文
  "campaignname": "campaign_name",
  "campaignid": "campaign_id",
  "productid": "product_id",
  "creativetype": "creative_type",
  "videotitle": "video_title",
  "videoid": "vid",
  "tiktokaccount": "tt_account_name",
  "timeposted": "posted_at",
  "status": "status",
  "authorizationtype": "authorization_type",
  "cost": "cost",
  "skuorders": "orders",
  "grossrevenue": "gross_revenue",
  "productadimpressions": "impressions",
  "productadclicks": "clicks",
  "currency": "currency",
};

const REQUIRED: Array<keyof ParsedRow> = [
  "campaign_id", "product_id", "creative_type", "vid", "tt_account_name", "cost", "gross_revenue",
];

function normCreativeType(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "视频" || s === "video") return "video";
  if (s === "商品卡片" || s === "product card" || s === "商品卡") return "product_card";
  if (s === "直播" || s === "live") return "live";
  return raw.trim();
}

/**
 * 金额/计数解析。返回 NaN 表示「原文非空但不是数字」，由调用方决定是记 0 还是计入诊断——
 * 旧实现把这种情况直接吞成 0，一列 GMV 全部解析失败时表面上看不出任何异常。
 * 处理：千分位、常见币种符号、普通/不换行/窄空格、全角数字、百分号、括号负数。
 */
function parseNumeric(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : NaN;
  let s = String(v ?? "")
    .normalize("NFKC") // 全角数字/符号 → 半角
    .replace(/[\s\u00a0\u202f\u2007]/g, "") // 空格、不换行空格、窄空格
    .replace(/,/g, "");
  if (!s || s === "-" || s === "—" || s.toUpperCase() === "N/A" || s.toUpperCase() === "NA") return NaN;
  let neg = false;
  const paren = s.match(/^\((.*)\)$/); // (123.45) = -123.45
  if (paren) {
    neg = true;
    s = paren[1];
  }
  s = s.replace(/[^\d.\-+eE]/g, ""); // 去掉 $ ₱ ฿ ¥ % 等
  if (!s || !/\d/.test(s)) return NaN;
  const n = Number(s);
  if (!isFinite(n)) return NaN;
  return neg ? -n : n;
}

/** 数值列：解析失败记 0（与历史行为一致），失败与否由调用方通过 parseNumeric 另行统计。 */
function toNum(v: unknown): number {
  const n = parseNumeric(v);
  return isFinite(n) ? n : 0;
}

/** 可空数值列（ROI / 曝光 / 点击）：空或解析失败都记 null。 */
function toNumOrNull(v: unknown): number | null {
  const n = parseNumeric(v);
  return isFinite(n) ? n : null;
}

function toPostedAt(v: unknown): string {
  if (v == null || v === "") return "";
  // Excel 日期序列号
  if (typeof v === "number" && isFinite(v) && v > 1 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 16).replace("T", " ");
  }
  const s = String(v).trim();
  if (!s || s === "-" || s.toUpperCase() === "N/A") return "";
  return s;
}

/** 解析一份导出 Excel。表头不符合会 throw，消息里带缺失列名。 */
export async function parseAdExcel(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`${file.name}: 找不到工作表`);
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
  if (!grid.length) throw new Error(`${file.name}: 空表`);

  const headerRow = grid[0] as unknown[];
  const colIdx = new Map<keyof ParsedRow, number>();
  let cnHits = 0;
  let enHits = 0;
  headerRow.forEach((h, i) => {
    const key = HEADER_MAP[normHeader(h)];
    if (key && !colIdx.has(key)) {
      colIdx.set(key, i);
      if (/[一-龥]/.test(String(h))) cnHits++;
      else enHits++;
    }
  });
  const missing = REQUIRED.filter((k) => !colIdx.has(k));
  if (missing.length) {
    throw new Error(`${file.name}: 表头不符合 TikTok 广告导出格式，缺少列：${missing.join("、")}`);
  }

  const cell = (row: unknown[], key: keyof ParsedRow): unknown => {
    const i = colIdx.get(key);
    return i == null ? "" : row[i];
  };
  const cellStr = (row: unknown[], key: keyof ParsedRow): string => String(cell(row, key) ?? "").trim();

  // 表头里没被 HEADER_MAP 认出来的列：TikTok 改列名时这里会暴露出来
  const unmappedHeaders = headerRow
    .map((h) => String(h ?? "").trim())
    .filter((h) => h && !HEADER_MAP[normHeader(h)])
    .slice(0, 12);
  const missingCurrencyColumn = !colIdx.has("currency");

  const rows: ParsedRow[] = [];
  const totals = { gmv: 0, cost: 0, rows: 0, productCardRows: 0, gmvRows: 0 };
  const curMap = new Map<string, CurrencyTotal>();
  let badNumberCells = 0;
  const badNumberSamples: string[] = [];
  const noteBad = (raw: unknown) => {
    badNumberCells++;
    if (badNumberSamples.length < 5) badNumberSamples.push(String(raw));
  };
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] as unknown[];
    if (!r || r.every((c) => c == null || String(c).trim() === "")) continue;
    const vidRaw = cellStr(r, "vid");
    const vid = /^\d{15,20}$/.test(vidRaw) ? vidRaw : "";
    const acctRaw = cellStr(r, "tt_account_name");
    const creativeType = normCreativeType(cellStr(r, "creative_type"));
    // 金额两列单独走一遍，统计「原文非空但解析不出数字」的单元格
    for (const k of ["cost", "gross_revenue"] as const) {
      const raw = cell(r, k);
      if (String(raw ?? "").trim() !== "" && !isFinite(parseNumeric(raw))) noteBad(raw);
    }
    const row: ParsedRow = {
      row_no: i + 1,
      campaign_name: cellStr(r, "campaign_name"),
      campaign_id: cellStr(r, "campaign_id"),
      product_id: cellStr(r, "product_id"),
      creative_type: creativeType,
      video_title: cellStr(r, "video_title").slice(0, 2000),
      vid,
      tt_account_name: acctRaw === "-" ? "" : acctRaw,
      posted_at: toPostedAt(cell(r, "posted_at")),
      status: cellStr(r, "status"),
      authorization_type: cellStr(r, "authorization_type"),
      cost: toNum(cell(r, "cost")),
      orders: Math.round(toNum(cell(r, "orders"))),
      gross_revenue: toNum(cell(r, "gross_revenue")),
      roi: toNumOrNull(cell(r, "roi")),
      impressions: toNumOrNull(cell(r, "impressions")),
      clicks: toNumOrNull(cell(r, "clicks")),
      currency: cellStr(r, "currency") || "USD",
    };
    rows.push(row);
    totals.gmv += row.gross_revenue;
    totals.cost += row.cost;
    totals.rows++;
    if (row.gross_revenue !== 0) totals.gmvRows++;
    if (creativeType === "product_card") totals.productCardRows++;
    const cur = row.currency.toUpperCase();
    const ct = curMap.get(cur) ?? { currency: cur, gmv: 0, cost: 0, rows: 0 };
    ct.gmv += row.gross_revenue;
    ct.cost += row.cost;
    ct.rows++;
    curMap.set(cur, ct);
  }

  const fromName = parseFileName(file.name);
  return {
    fileName: file.name,
    country: fromName?.country ?? null,
    month: fromName?.month ?? null,
    headerLang: cnHits >= enHits ? "cn" : "en",
    rows,
    totals: { ...totals, byCurrency: Array.from(curMap.values()).sort((a, b) => b.gmv - a.gmv) },
    diagnostics: { missingCurrencyColumn, badNumberCells, badNumberSamples, unmappedHeaders },
  };
}
