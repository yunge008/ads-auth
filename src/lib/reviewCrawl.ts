// 抓取表（负责人爬虫导出，格式见 docs/LISTING_REVIEWS_PLAN.md §4.1）浏览器内解析：
// 文件名「站点 [ALL ]YYMMDD-YYMMDD.xlsx」→ 站点 + 日期段；sheet「评论」每条评价一行（含无留言）。
// 输出：逐日星级（全部行，评论时间在文件名日期段内）+ 有留言/回复的评价内容（必要列）。不读用户名、图片链接。
import * as XLSX from "xlsx";
import type { Stars } from "@/lib/reviewsApi";

export type CrawlText = {
  review_id: string; product_id: string; sku_id: string | null; seller_sku: string | null; star: number; review_at: string;
  order_id: string | null; content: string | null; content_zh: string | null; reply: string | null; reply_zh: string | null; img_count: number;
  imgs: [string, string][] | null; // [缩略图, 原图]
};
export type CrawlParsed = {
  file: string; shop_key: string; range_from: string; range_to: string;
  rows_total: number; rows_in_range: number; out_of_range: number; dup: number; bad: number;
  daily: { p: string; d: string; s: Stars }[]; texts: CrawlText[]; products: number;
  skuDaily: { p: string; k: string; d: string; s: Stars }[]; skuSpecs: { p: string; k: string; spec: string }[];
  zh_col: string | null; reply_zh_col: string | null;
};

const ymd = (s: string) => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
export function parseFileName(name: string): { shop_key: string; from: string; to: string } | null {
  const m = name.replace(/\.(xlsx|xls|csv)$/i, "").match(/^\s*([A-Za-z]{2}\d?(?:-[A-Za-z]{2})?)\s+(?:ALL\s+)?(\d{6})-(\d{6})/i);
  if (!m) return null;
  return { shop_key: m[1].toUpperCase(), from: ymd(m[2]), to: ymd(m[3]) };
}

const str = (v: unknown) => (v == null ? "" : String(v).trim());
function timeText(v: unknown): string {
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.y}-${p(d.m)}-${p(d.d)} ${p(d.H)}:${p(d.M)}:${p(Math.floor(d.S))}`;
  }
  return str(v).replace("T", " ").replace(/\//g, "-").slice(0, 19);
}

export async function parseCrawlFile(file: File): Promise<CrawlParsed> {
  const meta = parseFileName(file.name);
  if (!meta) throw new Error(`${file.name}：文件名应为「站点 YYMMDD-YYMMDD.xlsx」或「站点 ALL YYMMDD-YYMMDD.xlsx」`);
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets["评论"] ?? wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const head = (rows[0] ?? []).map(str);
  const col = (name: string) => head.indexOf(name);
  const need = ["星级", "评论 ID", "商品 ID", "评论时间"];
  const miss = need.filter((n) => col(n) < 0);
  if (miss.length) throw new Error(`${file.name}：缺少列 ${miss.join("、")}`);
  // 中文译文列：表头含「翻译」或「中文」；含「回复」的算回复译文
  const zhCols = head.map((h, i) => [h, i] as const).filter(([h]) => /翻译|中文/.test(h));
  const replyZh = zhCols.find(([h]) => /回复/.test(h));
  const contentZh = zhCols.find(([h]) => !/回复/.test(h));
  const C = {
    star: col("星级"), content: col("评论内容"), reply: col("回复内容"), id: col("评论 ID"), order: col("订单 ID"),
    pid: col("商品 ID"), sku: col("SKU ID"), skuSpec: col("SKU 规格"), time: col("评论时间"), img: col("评价图数量"),
  };
  const at = (r: unknown[], i: number) => (i < 0 ? "" : str(r[i]));
  // 评价图：优先「评价图」sheet（有缩略图），否则「评价图链接」列（按换行/逗号分，缩略图 = 原图）
  const imgMap = new Map<string, [string, string][]>();
  const imgWs = wb.Sheets["评价图"];
  if (imgWs) {
    const ir = XLSX.utils.sheet_to_json<unknown[]>(imgWs, { header: 1, raw: true, defval: null });
    const ih = (ir[0] ?? []).map(str);
    const iId = ih.indexOf("评论 ID"), iSeq = ih.indexOf("图片序号"), iUrl = ih.indexOf("图片链接"), iThumb = ih.indexOf("缩略图链接");
    if (iId >= 0 && iUrl >= 0) {
      const tmp = new Map<string, { seq: number; pair: [string, string] }[]>();
      for (const r of ir.slice(1)) {
        const id = str(r?.[iId]), url = str(r?.[iUrl]);
        if (!id || !/^https:\/\//.test(url)) continue;
        const thumb = iThumb >= 0 && /^https:\/\//.test(str(r[iThumb])) ? str(r[iThumb]) : url;
        const l = tmp.get(id) ?? [];
        l.push({ seq: Number(r[iSeq]) || l.length + 1, pair: [thumb, url] });
        tmp.set(id, l);
      }
      for (const [id, l] of tmp) imgMap.set(id, l.sort((a, b) => a.seq - b.seq).map((x) => x.pair));
    }
  }
  const C_IMGURL = head.indexOf("评价图链接");
  const seen = new Set<string>();
  const daily = new Map<string, Stars>();
  const skuDaily = new Map<string, Stars>();
  const specCount = new Map<string, Map<string, number>>(); // p|sku → 规格写法 → 次数
  const texts: CrawlText[] = [];
  let inRange = 0, out = 0, dup = 0, bad = 0;
  for (const r of rows.slice(1)) {
    if (!r || r.every((v) => v == null || v === "")) continue;
    const id = at(r, C.id), pid = at(r, C.pid), star = Number(at(r, C.star));
    const t = timeText(r[C.time]);
    const d = t.slice(0, 10);
    if (!id || !pid || !(star >= 1 && star <= 5) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { bad++; continue; }
    if (seen.has(id)) { dup++; continue; }
    seen.add(id);
    if (d < meta.from || d > meta.to) { out++; continue; }
    inRange++;
    const k = `${pid}|${d}`;
    const s = daily.get(k) ?? [0, 0, 0, 0, 0];
    s[star - 1]++;
    daily.set(k, s as Stars);
    const sku = at(r, C.sku);
    if (sku) {
      const kk = `${pid}|${sku}|${d}`;
      const ss = skuDaily.get(kk) ?? [0, 0, 0, 0, 0];
      ss[star - 1]++;
      skuDaily.set(kk, ss as Stars);
      const spec = at(r, C.skuSpec);
      if (spec) {
        const m = specCount.get(`${pid}|${sku}`) ?? new Map<string, number>();
        m.set(spec, (m.get(spec) ?? 0) + 1);
        specCount.set(`${pid}|${sku}`, m);
      }
    }
    const content = at(r, C.content) || null, reply = at(r, C.reply) || null;
    if (content || reply) {
      texts.push({
        review_id: id, product_id: pid, sku_id: at(r, C.sku) || null, seller_sku: at(r, C.skuSpec) || null, star, review_at: t,
        order_id: at(r, C.order) || null, content, reply,
        content_zh: contentZh ? at(r, contentZh[1]) || null : null, reply_zh: replyZh ? at(r, replyZh[1]) || null : null,
        img_count: Number(at(r, C.img)) || 0,
        imgs: imgMap.get(id) ?? (() => {
          const urls = at(r, C_IMGURL).split(/[\s,]+/).filter((u) => /^https:\/\//.test(u));
          return urls.length ? urls.map((u) => [u, u] as [string, string]) : null;
        })(),
      });
    }
  }
  const dailyRows = [...daily.entries()].map(([k, s]) => { const [p, d] = k.split("|"); return { p, d, s }; });
  return {
    file: file.name, shop_key: meta.shop_key, range_from: meta.from, range_to: meta.to,
    rows_total: inRange + out + dup + bad, rows_in_range: inRange, out_of_range: out, dup, bad,
    daily: dailyRows, texts, products: new Set(dailyRows.map((x) => x.p)).size,
    zh_col: contentZh?.[0] ?? null, reply_zh_col: replyZh?.[0] ?? null,
    skuDaily: [...skuDaily.entries()].map(([k, s]) => { const [p, kk, d] = k.split("|"); return { p, k: kk, d, s }; }),
    skuSpecs: [...specCount.entries()].map(([k, m]) => { const [p, kk] = k.split("|"); return { p, k: kk, spec: [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] }; }),
  };
}
