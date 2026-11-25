// 「评论查看」页后端：Listing 评价监控。计划与口径：docs/LISTING_REVIEWS_PLAN.md
//
// 数据来源：
//   1. 抓取表（负责人爬虫导出，网页端解析后分片上传）：逐日 1–5 星条数（全部行）+ 有留言/回复的评价内容
//   2. TikTok Shop Analytics 商品表现详情 GET /analytics/202509/shop_products/{product_id}/performance
//      实测（2026-11-25）：ratings[] 不受日期参数影响，是该 listing 截至调用时的全部历史累计；intervals[].sales.orders 按天给出单量
//      → 每晚每个商品 1 次调用：存累计快照，当日新增 = 今晚快照 − 上一份快照
//
// action：
//   页面（口令 + 「reviews」页面权限）：meta / series / table / texts / alerts / save_settings
//     upload_begin / upload_daily / upload_texts / upload_end（抓取表入库）
//   管理员：reconcile（接口当前累计 vs 本系统累计，逐商品）/ step（手动同步某站点）
//   cron（x-cron-key）：step（每晚同步，时间预算内分片续跑）/ alert_scan（提交差评提示状态，返回新跌破的 listing）
import { admin, requireAdmin, verifyPasscode } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttsCall, type TtsResult } from "../_shared/tts.ts";

const PRODUCT_START_LIMIT_MS = 90_000; // 超过 90s 不再开新商品（Edge Function 墙钟 150s；每个商品 1～3 次调用）
const DETAIL_PATH = (pid: string) => `/analytics/202509/shop_products/${pid}/performance`;
const MAX_SPAN_DAYS = 60; // 出单查询单次最长跨度（接口上限未核验，保守分段；只影响首次回补）

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
function bad(msg: string): never {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  throw e;
}
const apiErr = (name: string, r: TtsResult) => `${name}：http=${r.http_status} code=${r.code} ${r.message}`;

// ── 日期（全部按 YYYY-MM-DD 字符串，店铺当地日）────────────────────────────
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown, name: string) => {
  const s = String(v ?? "");
  if (!DATE_RE.test(s)) bad(`${name} 格式应为 YYYY-MM-DD`);
  return s;
};
const REGION_UTC_OFFSET: Record<string, number> = { PH: 8, MY: 8, SG: 8, TH: 7, VN: 7, JP: 9, US: -8, MX: -6 };
const localToday = (region: string) => new Date(Date.now() + (REGION_UTC_OFFSET[region] ?? 8) * 3600_000).toISOString().slice(0, 10);

// ── 店铺 ────────────────────────────────────────────────────────────────────
type Shop = { shop_id: string; shop_cipher: string; region: string; app_code: string | null; access_token: string; key: string };
/** 站点键：MX 三个店按应用区分（MX-AR / MX-NE / MX-SJ），其余用 region；与抓取表文件名、sku_product_map.country 一致 */
const shopKeyOf = (region: string, app: string | null) => (/^mx-/.test(app ?? "") ? String(app).toUpperCase() : region.toUpperCase());
async function loadShops(): Promise<Shop[]> {
  const { data, error } = await admin().from("tts_shops").select("shop_id,shop_cipher,region,app_code,access_token,status").eq("status", "ACTIVE");
  if (error) throw error;
  return (data ?? []).map((s) => ({ ...s, region: String(s.region ?? "").toUpperCase(), key: shopKeyOf(String(s.region ?? ""), s.app_code) })) as Shop[];
}

// ── 接口：一段日期的星级合计 + 逐日出单 ────────────────────────────────────
type Stars = [number, number, number, number, number];
type Detail = { stars: Stars; orders: Map<string, number>; latest: string | null };
async function detail(shop: Shop, pid: string, from: string, toIncl: string, daily: boolean): Promise<Detail> {
  const r = await ttsCall<{
    performance?: { intervals?: { start_date?: string; sales?: { orders?: number } }[]; ratings?: { stars?: string; count?: number }[] };
    latest_available_date?: string;
  }>({
    method: "GET", path: DETAIL_PATH(pid), accessToken: shop.access_token, shopCipher: shop.shop_cipher,
    query: { start_date_ge: from, end_date_lt: addDays(toIncl, 1), granularity: daily ? "1D" : "ALL", currency: "LOCAL" },
  });
  if (r.code !== 0) throw new Error(apiErr(`商品 ${pid} ${from}~${toIncl}`, r));
  const stars: Stars = [0, 0, 0, 0, 0];
  for (const x of r.data?.performance?.ratings ?? []) {
    const n = Number(String(x.stars ?? "").charAt(0));
    if (n >= 1 && n <= 5) stars[n - 1] += Number(x.count ?? 0) || 0;
  }
  const orders = new Map<string, number>();
  if (daily) for (const iv of r.data?.performance?.intervals ?? []) if (iv.start_date) orders.set(iv.start_date, Number(iv.sales?.orders ?? 0) || 0);
  return { stars, orders, latest: r.data?.latest_available_date ?? null };
}
const sumStars = (rows: { s1: number; s2: number; s3: number; s4: number; s5: number }[]): Stars =>
  rows.reduce<Stars>((t, r) => [t[0] + r.s1, t[1] + r.s2, t[2] + r.s3, t[3] + r.s4, t[4] + r.s5], [0, 0, 0, 0, 0]);

/**
 * 同步一个商品（2026-11-25 实测口径：ratings 是截至调用时的全部历史累计，不随日期参数变化）：
 * 1 次 granularity=1D 调用 [from, end]：逐日出单写 api 行；ratings 存为 end 日快照；
 * end 日新增 = 本次快照 − 上一份快照（source=api）；没有上一份快照时 = 快照 − 已知累计（抓取表 + 已有接口行），记 api_init。
 * 出单区间超过 MAX_SPAN_DAYS 时分段（只影响首次回补）。返回调用次数。
 */
async function syncProduct(shop: Shop, pid: string, from: string, end: string, crawlUntil: string | null): Promise<number> {
  const db = admin();
  let calls = 0;
  let snap: Stars | null = null;
  const orders = new Map<string, number>();
  for (let a = from; a <= end; a = addDays(a, MAX_SPAN_DAYS)) {
    const b = [addDays(a, MAX_SPAN_DAYS - 1), end].sort()[0];
    const r = await detail(shop, pid, a, b, true);
    calls++;
    for (const [d, o] of r.orders) orders.set(d, o);
    snap = r.stars; // 与日期无关，取最后一次
  }
  const { data: have, error } = await db.from("review_daily").select("d,s1,s2,s3,s4,s5,orders")
    .eq("shop_key", shop.key).eq("product_id", pid).eq("source", "api").gte("d", from).lte("d", end);
  if (error) throw error;
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of have ?? []) rows.set(String(r.d), { ...r });
  for (const [d, o] of orders) {
    if (o > 0 || rows.has(d)) rows.set(d, { ...(rows.get(d) ?? { d, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 }), orders: o });
  }
  // 快照 → 新增
  await upsertOrThrow("review_snapshot", [{ shop_key: shop.key, product_id: pid, d: end, s1: snap![0], s2: snap![1], s3: snap![2], s4: snap![3], s5: snap![4], fetched_at: new Date().toISOString() }], "shop_key,product_id,d");
  const { data: prev } = await db.from("review_snapshot").select("d,s1,s2,s3,s4,s5").eq("shop_key", shop.key).eq("product_id", pid)
    .lt("d", end).order("d", { ascending: false }).limit(1).maybeSingle();
  let init: Stars | null = null;
  if (prev) {
    const delta = snap!.map((v, i) => v - [prev.s1, prev.s2, prev.s3, prev.s4, prev.s5][i]) as Stars;
    rows.set(end, { ...(rows.get(end) ?? { d: end, orders: orders.get(end) ?? 0 }), s1: delta[0], s2: delta[1], s3: delta[2], s4: delta[3], s5: delta[4] });
  } else {
    // 已知累计 = 抓取表（≤ crawl_until）+ 已有接口行（> crawl_until 且 < end）
    const cu = crawlUntil ?? "1900-01-01";
    const sel = (src: string) => db.from("review_daily").select("s1,s2,s3,s4,s5").eq("shop_key", shop.key).eq("product_id", pid).eq("source", src).order("d");
    const crawlRows = await readAll<{ s1: number; s2: number; s3: number; s4: number; s5: number }>((f, t) => sel("crawl").lte("d", cu).range(f, t));
    const apiRows = await readAll<{ s1: number; s2: number; s3: number; s4: number; s5: number }>((f, t) => sel("api").gt("d", cu).lt("d", end).range(f, t));
    const known = sumStars([...crawlRows, ...apiRows]);
    init = snap!.map((v, i) => v - known[i]) as Stars;
    // end 日的新增并入初始差额；end 日 api 行只留出单
    rows.set(end, { d: end, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, orders: orders.get(end) ?? 0 });
  }
  const now = new Date().toISOString();
  const up = [...rows.values()].map((r) => ({
    shop_key: shop.key, product_id: pid, d: r.d, source: "api", s1: r.s1 ?? 0, s2: r.s2 ?? 0, s3: r.s3 ?? 0, s4: r.s4 ?? 0, s5: r.s5 ?? 0,
    orders: r.orders ?? 0, updated_at: now,
  }));
  if (up.length) await upsertOrThrow("review_daily", up, "shop_key,product_id,d,source");
  if (init && init.some((v) => v !== 0)) {
    await upsertOrThrow("review_daily", [{ shop_key: shop.key, product_id: pid, d: end, source: "api_init", s1: init[0], s2: init[1], s3: init[2], s4: init[3], s5: init[4], orders: null, updated_at: now }], "shop_key,product_id,d,source");
  }
  return calls;
}
async function upsertOrThrow(table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await admin().from(table).upsert(rows.slice(i, i + 1000), { onConflict });
    if (error) throw new Error(`${table}：${error.message}`);
  }
}
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await page(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

// ── 每晚同步：选商品 → 逐个 syncProduct（游标存 review_shops.state）────────
type ShopState = { run_date?: string; from?: string; end?: string; products?: string[]; idx?: number; done?: boolean; calls?: number };
async function pickProducts(shop: Shop, end: string): Promise<string[]> {
  const ids = new Set<string>();
  // ① 近 90 天有出单的商品（Analytics 商品表现列表，每页 100）
  let token = "";
  for (let page = 0; page < 100; page++) {
    const r = await ttsCall<{ products?: { id?: string; total_performance?: { orders?: number } }[]; next_page_token?: string }>({
      method: "GET", path: "/analytics/202605/shop_products/performance", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { start_date_ge: addDays(end, -89), end_date_lt: addDays(end, 1), page_size: 100, page_token: token, sort_field: "orders", sort_order: "DESC", currency: "LOCAL" },
    });
    if (r.code !== 0) throw new Error(apiErr("商品表现列表", r));
    let zero = false;
    for (const p of r.data?.products ?? []) {
      if ((Number(p.total_performance?.orders ?? 0) || 0) > 0) ids.add(String(p.id));
      else zero = true;
    }
    token = r.data?.next_page_token ?? "";
    if (!token || zero) break; // 按出单降序，出现 0 单即可停
  }
  // ② 近 30 天有新评价的商品（库内）
  const { data } = await admin().from("review_daily").select("product_id,s1,s2,s3,s4,s5").eq("shop_key", shop.key).gte("d", addDays(end, -29));
  for (const r of data ?? []) if (r.s1 + r.s2 + r.s3 + r.s4 + r.s5 > 0) ids.add(String(r.product_id));
  // ③ 每周日（北京时间）补全部在售商品
  if (new Date(Date.now() + 8 * 3600_000).getUTCDay() === 0) {
    let t = "";
    for (let page = 0; page < 200; page++) {
      const r = await ttsCall<{ products?: { id?: string }[]; next_page_token?: string }>({
        method: "POST", path: "/product/202502/products/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
        query: { page_size: 100, page_token: t }, body: { status: "ACTIVATE" },
      });
      if (r.code !== 0) throw new Error(apiErr("在售商品列表", r));
      for (const p of r.data?.products ?? []) if (p.id) ids.add(String(p.id));
      t = r.data?.next_page_token ?? "";
      if (!t) break;
    }
  }
  return [...ids];
}

async function stepShop(shop: Shop, started: number): Promise<{ shop: string; done: boolean; idx: number; total: number; calls: number; error?: string }> {
  const db = admin();
  const { data: row } = await db.from("review_shops").select("*").eq("shop_key", shop.key).maybeSingle();
  const runDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  let st = (row?.state ?? {}) as ShopState;
  try {
    if (st.run_date !== runDate) {
      // 新的一晚：截止日 = 店铺当地昨天；出单起点 = 上次同步之后往前 7 天（出单会因取消/退款回改），首次 = 抓取表覆盖之后，最多回补 120 天
      const end = addDays(localToday(shop.region), -1);
      const since = row?.api_until ?? row?.crawl_until ?? addDays(end, -90);
      const from = [addDays(end, -7), addDays(since, 1)].sort()[0];
      const products = await pickProducts(shop, end);
      st = { run_date: runDate, from: from < addDays(end, -120) ? addDays(end, -120) : from, end, products, idx: 0, done: false, calls: 0 };
      for (let i = 0; i < products.length; i += 500) {
        await db.from("review_products").upsert(products.slice(i, i + 500).map((product_id) => ({ shop_key: shop.key, product_id })), { onConflict: "shop_key,product_id", ignoreDuplicates: true });
      }
    }
    const list = st.products ?? [];
    while (!st.done && (st.idx ?? 0) < list.length && Date.now() - started < PRODUCT_START_LIMIT_MS) {
      st.calls = (st.calls ?? 0) + await syncProduct(shop, list[st.idx!], st.from!, st.end!, row?.crawl_until ?? null);
      st.idx = (st.idx ?? 0) + 1;
    }
    const finished = (st.idx ?? 0) >= list.length;
    if (finished) st.done = true;
    await db.from("review_shops").upsert({
      shop_key: shop.key, state: st, last_run_at: new Date().toISOString(), last_error: null,
      ...(finished ? { api_until: st.end, latest_available_date: st.end } : {}),
    }, { onConflict: "shop_key" });
    if (finished) await db.rpc("review_products_fill_sku");
    return { shop: shop.key, done: finished, idx: st.idx ?? 0, total: list.length, calls: st.calls ?? 0 };
  } catch (e) {
    const msg = (e as Error).message;
    await db.from("review_shops").upsert({ shop_key: shop.key, state: st, last_run_at: new Date().toISOString(), last_error: msg }, { onConflict: "shop_key" });
    return { shop: shop.key, done: false, idx: st.idx ?? 0, total: st.products?.length ?? 0, calls: st.calls ?? 0, error: msg };
  }
}

async function step(b: Record<string, unknown>, started: number) {
  const only = b.shop_key ? String(b.shop_key) : null;
  const shops = (await loadShops()).filter((s) => !only || s.key === only);
  const results = [];
  for (const s of shops) {
    if (Date.now() - started > PRODUCT_START_LIMIT_MS) break;
    const runDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const { data: row } = await admin().from("review_shops").select("state").eq("shop_key", s.key).maybeSingle();
    const st = (row?.state ?? {}) as ShopState;
    if (st.run_date === runDate && st.done) continue;
    results.push(await stepShop(s, started));
    if (!results[results.length - 1].done && !results[results.length - 1].error) break; // 时间用完，下一轮续跑
  }
  const runDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const { data: all } = await admin().from("review_shops").select("shop_key,state");
  const pending = shops.filter((s) => {
    const st = ((all ?? []).find((r) => r.shop_key === s.key)?.state ?? {}) as ShopState;
    return !(st.run_date === runDate && st.done);
  }).map((s) => s.key);
  return { finished: pending.length === 0, pending, results };
}

// ── 核对：接口累计快照（当前）vs 本系统累计（抓取表 + 接口新增 + 初始差额）────────
// 每个商品 1 次调用；差 = 抓取表/接口都没覆盖到的评价（如抓取截止日之后、今晚同步之前新增的）
async function reconcile(b: Record<string, unknown>) {
  const key = String(b.shop_key ?? "");
  const shop = (await loadShops()).find((s) => s.key === key);
  if (!shop) bad(`站点 ${key} 没有已授权店铺`);
  const db = admin();
  const { data: sh } = await db.from("review_shops").select("crawl_until").eq("shop_key", key).maybeSingle();
  const cu = sh?.crawl_until ?? "1900-01-01";
  let pids = (Array.isArray(b.product_ids) ? b.product_ids : []).map(String).filter(Boolean).slice(0, 20);
  const rows = await readAll<{ product_id: string; d: string; source: string; s1: number; s2: number; s3: number; s4: number; s5: number }>((f, t) => {
    let q = db.from("review_daily").select("product_id,d,source,s1,s2,s3,s4,s5").eq("shop_key", key).order("product_id").order("d").order("source");
    if (pids.length) q = q.in("product_id", pids);
    return q.range(f, t);
  });
  const ours = new Map<string, Stars>();
  for (const r of rows) {
    const ok = (r.source === "crawl" && r.d <= cu) || (r.source !== "crawl" && r.d > cu);
    if (!ok) continue;
    const t = ours.get(r.product_id) ?? [0, 0, 0, 0, 0];
    ours.set(r.product_id, [t[0] + r.s1, t[1] + r.s2, t[2] + r.s3, t[3] + r.s4, t[4] + r.s5]);
  }
  const tot = (x: Stars) => x.reduce((a, c) => a + c, 0);
  if (!pids.length) pids = [...ours.entries()].sort((x, y) => tot(y[1]) - tot(x[1])).slice(0, 10).map((x) => x[0]); // 默认评价最多的 10 个
  if (!pids.length) bad(`${key} 没有数据，先上传抓取表`);
  const end = addDays(localToday(shop.region), -1);
  const out = [];
  for (const pid of pids) {
    const api = (await detail(shop, pid, end, end, false)).stars;
    const our = ours.get(pid) ?? [0, 0, 0, 0, 0];
    const avg = (s: Stars) => { const n = s.reduce((a, c) => a + c, 0); return n ? s.reduce((a, c, i) => a + c * (i + 1), 0) / n : null; };
    out.push({ pid, api, ours: our, diff: api.map((v, i) => v - our[i]), api_avg: avg(api), our_avg: avg(our as Stars) });
  }
  return { shop_key: key, crawl_until: sh?.crawl_until ?? null, products: out };
}

// ── 上传（网页端解析抓取表后分片调用）─────────────────────────────────────
async function uploadBegin(b: Record<string, unknown>, who: string) {
  const key = String(b.shop_key ?? "").toUpperCase();
  if (!/^[A-Z]{2}\d?(-[A-Z]{2})?$/.test(key)) bad("站点无效");
  const from = asDate(b.range_from, "range_from");
  const to = asDate(b.range_to, "range_to");
  const db = admin();
  // 同站点同日期段的抓取行整体替换（同一批评价重复上传不会重复计数）
  const { error } = await db.from("review_daily").delete().eq("shop_key", key).eq("source", "crawl").gte("d", from).lte("d", to);
  if (error) throw error;
  const { data, error: e2 } = await db.from("review_uploads").insert({
    shop_key: key, file_name: String(b.file_name ?? ""), range_from: from, range_to: to,
    rows_total: Number(b.rows_total ?? 0), rows_in_range: Number(b.rows_in_range ?? 0), rows_text: Number(b.rows_text ?? 0),
    products: Number(b.products ?? 0), uploaded_by: who,
  }).select("id").single();
  if (e2) throw e2;
  return { upload_id: data.id };
}
async function uploadDaily(b: Record<string, unknown>) {
  const key = String(b.shop_key ?? "").toUpperCase();
  const rows = (Array.isArray(b.rows) ? b.rows : []) as { p: string; d: string; s: number[] }[];
  if (rows.length > 5000) bad("每片最多 5000 行");
  const db = admin();
  const daily = rows.map((r) => ({ shop_key: key, product_id: String(r.p), d: asDate(r.d, "d"), source: "crawl", s1: r.s[0] | 0, s2: r.s[1] | 0, s3: r.s[2] | 0, s4: r.s[3] | 0, s5: r.s[4] | 0 }));
  const { error } = await db.from("review_daily").upsert(daily, { onConflict: "shop_key,product_id,d,source" });
  if (error) throw error;
  const prods = [...new Set(daily.map((r) => r.product_id))].map((product_id) => ({ shop_key: key, product_id }));
  const { error: e2 } = await db.from("review_products").upsert(prods, { onConflict: "shop_key,product_id", ignoreDuplicates: true });
  if (e2) throw e2;
  return { ok: true, rows: daily.length };
}
async function uploadTexts(b: Record<string, unknown>) {
  const key = String(b.shop_key ?? "").toUpperCase();
  const rows = (Array.isArray(b.rows) ? b.rows : []) as Record<string, unknown>[];
  if (rows.length > 2000) bad("每片最多 2000 行");
  const t = (v: unknown, max = 4000) => (v == null || String(v).trim() === "" ? null : String(v).slice(0, max));
  const clean = rows.map((r) => ({
    review_id: String(r.review_id), shop_key: key, product_id: String(r.product_id), sku_id: t(r.sku_id, 40), seller_sku: t(r.seller_sku, 200),
    star: Number(r.star) | 0, review_at: t(r.review_at, 19), order_id: t(r.order_id, 40),
    content: t(r.content), content_zh: t(r.content_zh), reply: t(r.reply), reply_zh: t(r.reply_zh), img_count: Number(r.img_count) | 0,
  })).filter((r) => r.review_id && r.product_id && r.star >= 1 && r.star <= 5);
  const { data, error } = await admin().rpc("review_texts_upsert", { p_rows: clean });
  if (error) throw error;
  return { ok: true, rows: data };
}
async function uploadEnd(b: Record<string, unknown>) {
  const key = String(b.shop_key ?? "").toUpperCase();
  const db = admin();
  const { data: up } = await db.from("review_uploads").select("range_from,range_to").eq("id", String(b.upload_id ?? "")).maybeSingle();
  if (!up) bad("upload_id 不存在");
  const { data: row } = await db.from("review_shops").select("crawl_from,crawl_until").eq("shop_key", key).maybeSingle();
  const crawl_from = [row?.crawl_from, up.range_from].filter(Boolean).sort()[0];
  const crawl_until = [row?.crawl_until, up.range_to].filter(Boolean).sort().reverse()[0];
  const { error } = await db.from("review_shops").upsert({ shop_key: key, crawl_from, crawl_until }, { onConflict: "shop_key" });
  if (error) throw error;
  await db.from("review_uploads").update({ status: "READY" }).eq("id", String(b.upload_id));
  await db.rpc("review_products_fill_sku");
  return { ok: true, crawl_from, crawl_until };
}

// ── 页面查询 ────────────────────────────────────────────────────────────────
const shopsArg = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await admin().rpc(name, args);
  if (error) throw new Error(`${name}：${error.message}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const started = Date.now();
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(b.action ?? "");
    const db = admin();
    // cron 只放行 step / alert_scan
    if ((action === "step" || action === "alert_scan") && (await cronAuthed(req))) {
      if (action === "step") return json(await step(b, started));
      return json(await rpc("review_alert_scan", { p_commit: true }));
    }
    if (action === "step" || action === "reconcile") {
      await requireAdmin(req);
      return json(action === "step" ? await step(b, started) : await reconcile(b));
    }
    const acc = await verifyPasscode(req, "reviews");
    const from = () => asDate(b.from, "from");
    const to = () => asDate(b.to, "to");
    const q = () => String(b.q ?? "").trim().slice(0, 40) || null;
    switch (action) {
      case "meta": {
        const [shops, settings, uploads, tts] = await Promise.all([
          db.from("review_shops").select("shop_key,crawl_from,crawl_until,api_until,latest_available_date,last_run_at,last_error,state"),
          db.from("review_settings").select("min_reviews,threshold,updated_at,updated_by").eq("id", 1).maybeSingle(),
          db.from("review_uploads").select("shop_key,file_name,range_from,range_to,rows_total,rows_in_range,rows_text,products,status,uploaded_by,created_at").order("created_at", { ascending: false }).limit(50),
          loadShops(),
        ]);
        return json({
          shops: (shops.data ?? []).map((s) => {
            const st = (s.state ?? {}) as ShopState;
            return { ...s, state: undefined, run_date: st.run_date ?? null, run_done: !!st.done, run_idx: st.idx ?? 0, run_total: st.products?.length ?? 0 };
          }),
          api_sites: [...new Set(tts.map((s) => s.key))].sort(),
          settings: settings.data, uploads: uploads.data ?? [], is_admin: acc.isAdmin,
        });
      }
      case "series": return json(await rpc("review_series", { p_shops: shopsArg(b.sites), p_from: from(), p_to: to(), p_q: q() }));
      case "table": return json({ rows: await rpc("review_table", { p_shops: shopsArg(b.sites), p_from: from(), p_to: to(), p_q: q() }) });
      case "texts": {
        const pid = String(b.product_id ?? "");
        if (!pid) bad("product_id 必填");
        let qq = db.from("review_texts").select("review_id,star,review_at,order_id,seller_sku,content,content_zh,reply,reply_zh,img_count")
          .eq("product_id", pid).gte("review_at", `${from()} 00:00:00`).lte("review_at", `${to()} 23:59:59`)
          .order("review_at", { ascending: false }).limit(300);
        const st = Array.isArray(b.stars) ? b.stars.map(Number).filter((n) => n >= 1 && n <= 5) : [];
        if (st.length) qq = qq.in("star", st);
        const { data, error } = await qq;
        if (error) throw error;
        return json({ rows: data ?? [] });
      }
      case "alerts": return json(await rpc("review_alert_scan", { p_commit: false }));
      case "save_settings": {
        const min = Math.round(Number(b.min_reviews));
        const thr = Number(b.threshold);
        if (!(min >= 1 && min <= 1000)) bad("评价数门槛 1～1000");
        if (!(thr >= 1 && thr <= 5)) bad("提示分数 1～5");
        const { error } = await db.from("review_settings").update({ min_reviews: min, threshold: Math.round(thr * 100) / 100, updated_at: new Date().toISOString(), updated_by: acc.name }).eq("id", 1);
        if (error) throw error;
        return json({ ok: true });
      }
      case "upload_begin": return json(await uploadBegin(b, acc.name));
      case "upload_daily": return json(await uploadDaily(b));
      case "upload_texts": return json(await uploadTexts(b));
      case "upload_end": return json(await uploadEnd(b));
    }
    bad("未知 action");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
