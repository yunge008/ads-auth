// 达人出单日报（docs/CREATOR_ORDERS_PLAN.md）服务端逻辑。
// - sync：GMV Max 报表 素材 × 商品，按天（广告户时区）拉今天及前两天，覆盖写 co_daily（只存非 0 行）。
// - enrichNames：新出现的 VID 查 TikTok Shop 视频接口补用户名 / 昵称 / 账号类型 → co_vid。
// - query：页面查询（区间聚合 + 达人名 + 主 SKU + 归属同事）。
// TikTok Business 调用复用 _shared 的 ttGet / fetchReport / fetchCampaigns（限速 + 退避 + 无效 metric 剔除）。
// TikTok Shop 调用只用 GET（只读），签名算法与 supabase/functions/_shared/tts.ts 的 ttsSign 相同（那边依赖 Deno，不能在这里 import）。
import { createHash, createHmac } from "node:crypto";
import process from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ttGet } from "../../supabase/functions/_shared/tiktok.ts";
import { fetchCampaigns, fetchReport } from "../../supabase/functions/_shared/gmv-max-report.ts";

export const CO_TAB = "creator-orders";

export function adminDb(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 口令校验（与 _shared/auth.ts verifyPasscode 的数据库路径一致：先明文、再 sha256；需启用且有本页权限或管理员）。 */
export async function checkCoPasscode(
  db: SupabaseClient,
  request: Request,
): Promise<string | null> {
  const got = (request.headers.get("x-admin-passcode") ?? "").trim();
  if (!got) return "未登录";
  let name = (request.headers.get("x-admin-name") ?? "").trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  const cols = "name,is_admin,tab_permissions,active";
  const lookup = async (col: "passcode" | "passcode_hash", val: string) => {
    let q = db.from("app_accounts").select(cols).eq(col, val);
    if (name) q = q.eq("name", name);
    const { data, error } = await q.limit(2);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  let rows = await lookup("passcode", got);
  if (!rows.length)
    rows = await lookup("passcode_hash", createHash("sha256").update(got).digest("hex"));
  if (rows.length !== 1)
    return rows.length ? "多个账号使用同一密码，请输入用户名" : "用户名或密码错误";
  const a = rows[0] as { is_admin: boolean; tab_permissions: unknown; active: boolean };
  if (!a.active) return "账号已停用";
  const tabs = Array.isArray(a.tab_permissions) ? (a.tab_permissions as string[]) : [];
  if (!a.is_admin && !tabs.includes(CO_TAB)) return "没有「达人出单」页面权限";
  return null;
}

// ───────────────────────── 日期 ─────────────────────────
/** 新加坡（UTC+8）日期，offset 天 */
export function sgDate(offset = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
}

/** 与 attribution.ts normalizeName 相同：NFKC + trim + 空白折叠 + 小写 */
export function normName(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return t === "-" || t === "n/a" || t === "na" || t === "none" || t === "null" ? "" : t;
}
const normHandle = (s: string | null | undefined) =>
  String(s ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();

const chunk = <T>(a: T[], n: number) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const cents = (v: unknown) => Math.round(num(v) * 100);

// ───────────────────────── GMV Max 同步 ─────────────────────────
type Adv = {
  advertiser_id: string;
  country: string;
  shop_id: string;
  advertiser_name: string | null;
};

const MONEY = [
  "cost",
  "orders",
  "gross_revenue",
  "product_impressions",
  "product_clicks",
  "currency",
];

async function tokensFor(db: SupabaseClient, advId: string): Promise<string[]> {
  const { data } = await db
    .from("tiktok_connections")
    .select("access_token")
    .contains("advertiser_ids", [advId]);
  return ((data ?? []) as { access_token: string }[]).map((c) => c.access_token).filter(Boolean);
}

/** TikTok 报「timed out」时把 ID 列表对半拆开重试（大户一次查太多商品会超时，11-27 ECO9B-PH 实测）。 */
async function splitting<T>(items: string[], run: (part: string[]) => Promise<T[]>): Promise<T[]> {
  try {
    return await run(items);
  } catch (e) {
    if (items.length > 1 && /timed out|timeout/i.test((e as Error).message)) {
      const h = Math.ceil(items.length / 2);
      return [
        ...(await splitting(items.slice(0, h), run)),
        ...(await splitting(items.slice(h), run)),
      ];
    }
    throw e;
  }
}

/** 拉一个广告户一天的 素材 × 商品 数据（不带 stat_time_day 维度：区间=当天，返回含 0 花费的素材，口径与导出表一致）。 */
async function fetchAdvDay(token: string, adv: Adv, day: string, campaignIds: string[]) {
  // ① 商品级：该日有数据的 系列 × 商品
  const pairs: { cid: string; spu: string }[] = [];
  for (const cb of chunk(campaignIds, 50)) {
    const rows = await splitting(cb, (part) =>
      fetchReport(
        token,
        adv.advertiser_id,
        adv.shop_id,
        day,
        day,
        ["campaign_id", "item_group_id"],
        { campaign_ids: part },
        ["cost", "orders", "gross_revenue"],
        ttGet,
      ),
    );
    for (const r of rows) {
      const d = (r.dimensions ?? {}) as Record<string, unknown>;
      const m = (r.metrics ?? {}) as Record<string, unknown>;
      if (num(m.cost) > 0 || num(m.orders) > 0 || num(m.gross_revenue) > 0)
        pairs.push({ cid: String(d.campaign_id), spu: String(d.item_group_id) });
    }
  }
  // ② 素材级：系列 ≤100、商品 ≤100 一批（多 ID 过滤拿不到属性字段，这里只要金额）
  const out = new Map<
    string,
    {
      vid: string;
      spu: string;
      cost: number;
      gmv: number;
      orders: number;
      imps: number;
      clicks: number;
    }
  >();
  let currency = "";
  const bySpu = new Map<string, Set<string>>();
  for (const p of pairs) (bySpu.get(p.spu) ?? bySpu.set(p.spu, new Set()).get(p.spu)!).add(p.cid);
  for (const spus of chunk([...bySpu.keys()], 20)) {
    {
      const rows = await splitting(spus, async (part) => {
        const cids = [...new Set(part.flatMap((x) => [...bySpu.get(x)!]))];
        const acc = [];
        for (const cb of chunk(cids, 100))
          acc.push(
            ...(await fetchReport(
              token,
              adv.advertiser_id,
              adv.shop_id,
              day,
              day,
              ["campaign_id", "item_group_id", "item_id"],
              { campaign_ids: cb, item_group_ids: part },
              MONEY,
              ttGet,
            )),
          );
        return acc;
      });
      for (const r of rows) {
        const d = (r.dimensions ?? {}) as Record<string, unknown>;
        const m = (r.metrics ?? {}) as Record<string, unknown>;
        if (m.currency) currency = String(m.currency);
        const vid = String(d.item_id ?? "");
        const spu = String(d.item_group_id ?? "");
        if (!vid || !spu) continue;
        const k = `${vid}|${spu}`;
        const x = out.get(k) ?? { vid, spu, cost: 0, gmv: 0, orders: 0, imps: 0, clicks: 0 };
        x.cost += cents(m.cost);
        x.gmv += cents(m.gross_revenue);
        x.orders += num(m.orders);
        x.imps += num(m.product_impressions);
        x.clicks += num(m.product_clicks);
        out.set(k, x);
      }
    }
  }
  return { rows: [...out.values()].filter((x) => x.cost || x.gmv || x.orders), currency };
}

/** 按 advertiser_id 顺序逐户同步；到 deadline 返回 next（下一户的序号），调用方从 next 续跑；全部完成 next=null。 */
export async function syncAll(
  db: SupabaseClient,
  opts: { days?: string[]; deadline: number; only?: string[]; start?: number; skipAt?: number },
) {
  // 最小步 = 广告户 × 天（大户单日数据量大，整户跑可能超过单次请求时长）；cursor = 步序号
  const days = opts.days ?? [sgDate(-2), sgDate(-1), sgDate(0)];
  const { data: advRows, error } = await db
    .from("advertiser_countries")
    .select("advertiser_id,country,shop_id,advertiser_name");
  if (error) throw new Error(error.message);
  const advs = ((advRows ?? []) as Adv[])
    .filter((a) => a.shop_id && (!opts.only || opts.only.includes(a.advertiser_id)))
    .sort((a, b) => a.advertiser_id.localeCompare(b.advertiser_id));
  const units = advs.flatMap((adv) => days.map((day) => ({ adv, day })));
  const report: { advertiser: string; day: string; rows?: number; error?: string }[] = [];
  const campCache = new Map<string, { token: string; campaigns: string[] }>();
  for (let i = opts.start ?? 0; i < units.length; i++) {
    const { adv, day } = units[i];
    if (Date.now() > opts.deadline) return { report, next: i, total: units.length };
    const state: Record<string, unknown> = {
      advertiser_id: adv.advertiser_id,
      country: adv.country,
      advertiser_name: adv.advertiser_name,
      last_run_at: new Date().toISOString(),
    };
    const name = adv.advertiser_name ?? adv.advertiser_id;
    try {
      if (opts.skipAt === i)
        throw new Error(`${day} 连续两次未跑完（单次请求超时），已跳过，下一轮重试`);
      let ctx = campCache.get(adv.advertiser_id);
      if (!ctx) {
        const tokens = await tokensFor(db, adv.advertiser_id);
        if (!tokens.length) throw new Error("没有授权连接包含此广告户");
        let lastErr = "";
        for (const token of tokens) {
          try {
            ctx = {
              token,
              campaigns: (await fetchCampaigns(token, adv.advertiser_id, ttGet)).map((c) => c.id),
            };
            break;
          } catch (e) {
            lastErr = (e as Error).message;
            if (!/40001|permission/i.test(lastErr)) break;
          }
        }
        if (!ctx) throw new Error(lastErr || "全部授权连接均无权限");
        campCache.set(adv.advertiser_id, ctx);
      }
      const { rows, currency } = ctx.campaigns.length
        ? await fetchAdvDay(ctx.token, adv, day, ctx.campaigns)
        : { rows: [], currency: "" };
      if (currency) state.currency = currency;
      const { error: de } = await db
        .from("co_daily")
        .delete()
        .eq("stat_date", day)
        .eq("advertiser_id", adv.advertiser_id);
      if (de) throw new Error(de.message);
      for (const part of chunk(rows, 1000)) {
        const { error: ie } = await db.from("co_daily").insert(
          part.map((x) => ({
            stat_date: day,
            advertiser_id: adv.advertiser_id,
            vid: x.vid,
            spu: x.spu,
            country: adv.country,
            cost_c: x.cost,
            gmv_c: x.gmv,
            orders: x.orders,
            imps: x.imps,
            clicks: x.clicks,
          })),
        );
        if (ie) throw new Error(ie.message);
      }
      state.last_ok_at = new Date().toISOString();
      state.last_rows = rows.length;
      state.last_error =
        state.currency && state.currency !== "USD"
          ? `币种 ${state.currency}：页面按 USD 显示，金额未换算`
          : null;
      report.push({ advertiser: name, day, rows: rows.length });
    } catch (e) {
      state.last_error = `${day}：${(e as Error).message}`.slice(0, 500);
      report.push({ advertiser: name, day, error: state.last_error as string });
    }
    await db.from("co_state").upsert(state, { onConflict: "advertiser_id" });
  }
  return { report, next: null as number | null, total: units.length };
}

// ───────────────────────── TikTok Shop（只读 GET） ─────────────────────────
type Shop = {
  shop_id: string;
  access_token: string;
  shop_cipher: string | null;
  app_key: string;
  app_secret: string;
};

async function ttsGet<T>(
  shop: Shop,
  path: string,
  query: Record<string, string>,
): Promise<{ code: number | null; message: string; data: T | null }> {
  const q: Record<string, string> = {
    ...query,
    app_key: shop.app_key,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  if (shop.shop_cipher) q.shop_cipher = shop.shop_cipher;
  const keys = Object.keys(q)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort();
  let s = path;
  for (const k of keys) s += k + q[k];
  q.sign = createHmac("sha256", shop.app_secret)
    .update(shop.app_secret + s + shop.app_secret)
    .digest("hex");
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(
      `https://open-api.tiktokglobalshop.com${path}?${new URLSearchParams(q)}`,
      {
        headers: { "content-type": "application/json", "x-tts-access-token": shop.access_token },
        signal: AbortSignal.timeout(30_000),
      },
    ).catch(
      (e) =>
        ({
          ok: false,
          status: 0,
          text: async () => JSON.stringify({ message: String(e) }),
        }) as unknown as Response,
    );
    const j = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: T };
    const limited = res.status === 429 || j.code === 36009002;
    if ((limited || res.status >= 500 || res.status === 0) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      continue;
    }
    return {
      code: typeof j.code === "number" ? j.code : null,
      message: j.message ?? `HTTP ${res.status}`,
      data: (j.data ?? null) as T | null,
    };
  }
  return { code: null, message: "重试用完", data: null };
}

async function shopsByCountry(db: SupabaseClient): Promise<Map<string, Shop>> {
  const [{ data: advs }, { data: shops }, { data: apps }] = await Promise.all([
    db.from("advertiser_countries").select("country,shop_id"),
    db.from("tts_shops").select("shop_id,access_token,shop_cipher,app_code"),
    db.from("tts_apps").select("code,app_key,app_secret"),
  ]);
  const appBy = new Map(
    ((apps ?? []) as { code: string; app_key: string; app_secret: string }[]).map((a) => [
      a.code,
      a,
    ]),
  );
  const shopBy = new Map(
    (
      (shops ?? []) as {
        shop_id: string;
        access_token: string;
        shop_cipher: string | null;
        app_code: string;
      }[]
    ).map((s) => [String(s.shop_id), s]),
  );
  const out = new Map<string, Shop>();
  for (const a of (advs ?? []) as { country: string; shop_id: string | null }[]) {
    const s = shopBy.get(String(a.shop_id ?? ""));
    const app = s ? appBy.get(s.app_code) : undefined;
    if (s && app?.app_key && app.app_secret && !out.has(a.country))
      out.set(a.country, {
        shop_id: s.shop_id,
        access_token: s.access_token,
        shop_cipher: s.shop_cipher,
        app_key: app.app_key,
        app_secret: app.app_secret,
      });
  }
  return out;
}

/** 补达人名：①视频列表（昨天，按 GMV 倒序到 0 为止，最多 5 页）给用户名 + 昵称 + 账号类型；②仍缺用户名的 VID 用 batch_performance 补用户名。 */
/** 按站点顺序补名；到 deadline 返回 next（下一个站点序号），全部完成 next=null。 */
export async function enrichNames(db: SupabaseClient, deadline: number, start = 0) {
  const since = sgDate(-3);
  const need = new Map<string, Set<string>>(); // country → vids
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("co_daily")
      .select("vid::text,country")
      .gte("stat_date", since)
      .gt("vid", 0)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { vid: string; country: string }[])
      (need.get(r.country) ?? need.set(r.country, new Set()).get(r.country)!).add(String(r.vid));
    if (!data || data.length < 1000) break;
  }
  const shops = await shopsByCountry(db);
  const report: Record<string, string> = {};
  const yday = sgDate(-1),
    today = sgDate(0);
  const list = [...need.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let ci = start; ci < list.length; ci++) {
    const [country, vidSet] = list[ci];
    if (Date.now() > deadline) return { report, next: ci, total: list.length };
    const shop = shops.get(country);
    if (!shop) {
      report[country] = "无 TikTok Shop 授权";
      continue;
    }
    const vids = [...vidSet];
    const known = new Map<
      string,
      { handle: string | null; nickname: string | null; checked_at: string | null }
    >();
    for (const part of chunk(vids, 500)) {
      const { data } = await db
        .from("co_vid")
        .select("vid::text,handle,nickname,checked_at")
        .in("vid", part);
      for (const r of (data ?? []) as {
        vid: string;
        handle: string | null;
        nickname: string | null;
        checked_at: string | null;
      }[])
        known.set(String(r.vid), r);
    }
    const stale = (k?: { checked_at: string | null }) =>
      !k?.checked_at || Date.now() - Date.parse(k.checked_at) > 86400_000;
    const missing = vids.filter((v) => !known.get(v)?.nickname && stale(known.get(v)));
    let filled = 0;
    if (missing.length) {
      // ① 视频列表
      let token = "";
      for (let page = 0; page < 5; page++) {
        const r = await ttsGet<{ next_page_token?: string; videos?: Record<string, unknown>[] }>(
          shop,
          "/analytics/202605/shop_videos/performance",
          {
            start_date_ge: yday,
            end_date_lt: today,
            page_size: "100",
            sort_field: "gmv",
            sort_order: "DESC",
            currency: "LOCAL",
            account_type: "ALL",
            ...(token ? { page_token: token } : {}),
          },
        );
        if (r.code !== 0) {
          report[country] = `视频列表：${r.message}`;
          break;
        }
        const list = r.data?.videos ?? [];
        const up = list.map((v) => {
          const c = (v.creator ?? {}) as Record<string, unknown>;
          return {
            vid: String(v.id),
            country,
            handle: (c.user_name ?? v.username ?? null) as string | null,
            nickname: (c.nick_name ?? null) as string | null,
            author_type: (c.author_type ?? null) as string | null,
            posted_local: (v.video_post_time ?? null) as string | null,
            checked_at: new Date().toISOString(),
          };
        });
        if (up.length) await db.from("co_vid").upsert(up, { onConflict: "vid" });
        filled += up.filter((x) => vidSet.has(x.vid)).length;
        token = r.data?.next_page_token ?? "";
        if (
          !token ||
          !list.length ||
          num((list[list.length - 1].gmv as { amount?: string } | undefined)?.amount) === 0
        )
          break;
      }
      // ② 仍缺用户名的：batch_performance
      const still: string[] = [];
      for (const part of chunk(missing, 500)) {
        const { data } = await db.from("co_vid").select("vid::text,handle").in("vid", part);
        const has = new Set(
          ((data ?? []) as { vid: string; handle: string | null }[])
            .filter((r) => r.handle)
            .map((r) => String(r.vid)),
        );
        still.push(...part.filter((v) => !has.has(v)));
      }
      for (const part of chunk(still, 100)) {
        if (Date.now() > deadline) break;
        const r = await ttsGet<{
          videos?: { video_id?: string; video?: Record<string, unknown> }[];
        }>(shop, "/analytics/202609/shop_videos/batch_performance", {
          video_ids: part.join(","),
          start_date_ge: sgDate(-59),
          end_date_lt: today,
          currency: "LOCAL",
        });
        if (r.code !== 0) {
          report[country] = `批量查询：${r.message}`;
          break;
        }
        const got = new Map(
          (r.data?.videos ?? []).map((v) => [
            String(v.video_id ?? v.video?.id ?? ""),
            v.video ?? {},
          ]),
        );
        const up = part.map((vid) => {
          const v = got.get(vid);
          return v
            ? {
                vid,
                country,
                handle: (v.username ?? null) as string | null,
                posted_local: (v.video_post_time ?? null) as string | null,
                checked_at: new Date().toISOString(),
              }
            : { vid, country, checked_at: new Date().toISOString() };
        });
        await db.from("co_vid").upsert(up, { onConflict: "vid" });
        filled += up.filter((x) => "handle" in x && x.handle).length;
      }
    }
    report[country] ??= `需补 ${missing.length}，补到 ${filled}`;
  }
  return { report, next: null as number | null, total: list.length };
}

// ───────────────────────── 页面查询 ─────────────────────────
/** 主 SKU：取 AR / NE 开头 + 3–4 位数字的基础货号；同一商品多行时取出现最多的（负责人定的「第一行」现表无行号，见计划 §2） */
export function baseSku(s: string | null | undefined): string {
  const m = String(s ?? "")
    .toUpperCase()
    .match(/\b(AR|NE)\d{3,4}/);
  return m ? m[0] : "";
}

export async function queryRange(
  db: SupabaseClient,
  start: string,
  end: string,
  countries: string[] | null,
) {
  const { data, error } = await db.rpc("co_query", {
    p_start: start,
    p_end: end,
    p_countries: countries,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as {
    country: string;
    vid: string;
    spu: string;
    cost_c: number;
    gmv_c: number;
    orders: number;
    imps: number;
    clicks: number;
    days: Record<string, [number, number, number]>;
  }[];
  const vids = [...new Set(rows.map((r) => String(r.vid)).filter((v) => v !== "-1"))];
  const spus = [...new Set(rows.map((r) => String(r.spu)))];

  const vidInfo = new Map<
    string,
    { handle: string | null; nickname: string | null; author_type: string | null }
  >();
  for (const part of chunk(vids, 500)) {
    const { data: d } = await db
      .from("co_vid")
      .select("vid::text,handle,nickname,author_type")
      .in("vid", part);
    for (const r of (d ?? []) as {
      vid: string;
      handle: string | null;
      nickname: string | null;
      author_type: string | null;
    }[])
      vidInfo.set(String(r.vid), r);
  }
  const skuOf = new Map<string, { sku: string; name: string | null }>();
  for (const part of chunk(spus, 300)) {
    const { data: d } = await db
      .from("sku_product_map")
      .select("product_id,merchant_sku,product_name")
      .in("product_id", part);
    const cnt = new Map<string, Map<string, number>>();
    const nameBy = new Map<string, string | null>();
    for (const r of (d ?? []) as {
      product_id: string;
      merchant_sku: string | null;
      product_name: string | null;
    }[]) {
      const b = baseSku(r.merchant_sku);
      if (!nameBy.has(r.product_id)) nameBy.set(r.product_id, r.product_name);
      if (!b) continue;
      const m = cnt.get(r.product_id) ?? new Map<string, number>();
      m.set(b, (m.get(b) ?? 0) + 1);
      cnt.set(r.product_id, m);
    }
    for (const pid of part) {
      const m = cnt.get(pid);
      const best = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : "";
      skuOf.set(pid, { sku: best, name: nameBy.get(pid) ?? null });
    }
  }
  // 归属：VID 登记（staff_vid_map）优先，其次达人（creator_ownership HANDLE → NICKNAME）
  const vidOwner = new Map<string, string>();
  for (const part of chunk(vids, 500)) {
    const { data: d } = await db
      .from("staff_vid_map")
      .select("country,vid,staff_name")
      .in("vid", part);
    for (const r of (d ?? []) as { country: string; vid: string; staff_name: string }[])
      vidOwner.set(`${r.country}|${r.vid}`, r.staff_name);
  }
  const keys = new Set<string>();
  for (const v of vidInfo.values()) {
    if (v.handle) keys.add(normHandle(v.handle));
    if (v.nickname) keys.add(normName(v.nickname));
  }
  const own = new Map<string, string>();
  for (const part of chunk([...keys].filter(Boolean), 300)) {
    const { data: d } = await db
      .from("creator_ownership")
      .select("country,key_type,match_key,owner_bd")
      .in("match_key", part);
    for (const r of (d ?? []) as {
      country: string;
      key_type: string;
      match_key: string;
      owner_bd: string | null;
    }[])
      if (r.owner_bd) own.set(`${r.country}|${r.key_type}|${r.match_key}`, r.owner_bd);
  }
  const { data: st } = await db
    .from("co_settings")
    .select("t_vid,t_cr,own_kw")
    .eq("id", 1)
    .maybeSingle();
  const ownKw = String(st?.own_kw ?? "artphro").toLowerCase();

  const out = rows.map((r) => {
    const vid = String(r.vid);
    const info = vidInfo.get(vid);
    const handle = info?.handle ?? null;
    const isOwn =
      info?.author_type === "OFFICIAL_ACCOUNTS" ||
      (!!handle && !!ownKw && handle.toLowerCase().includes(ownKw));
    const acct =
      vid === "-1"
        ? "card"
        : isOwn
          ? "own"
          : info?.author_type === "MARKETING_ACCOUNTS"
            ? "mk"
            : "ext";
    const owner =
      acct === "own"
        ? "官号"
        : (vidOwner.get(`${r.country}|${vid}`) ??
          (handle ? own.get(`${r.country}|HANDLE|${normHandle(handle)}`) : undefined) ??
          (info?.nickname
            ? own.get(`${r.country}|NICKNAME|${normName(info.nickname)}`)
            : undefined) ??
          null);
    const sku = skuOf.get(String(r.spu));
    return {
      site: r.country,
      vid,
      spu: String(r.spu),
      handle,
      nick: info?.nickname ?? null,
      acct,
      owner,
      sku: sku?.sku ?? "",
      pname: sku?.name ?? null,
      c: num(r.cost_c) / 100,
      g: num(r.gmv_c) / 100,
      o: num(r.orders),
      imp: num(r.imps),
      clk: num(r.clicks),
      d: Object.fromEntries(
        Object.entries(r.days ?? {}).map(([k, v]) => [
          k,
          [num(v[0]), num(v[1]) / 100, num(v[2]) / 100],
        ]),
      ),
    };
  });
  const { data: states } = await db
    .from("co_state")
    .select("advertiser_id::text,country,advertiser_name,last_ok_at,last_error,last_rows");
  return {
    rows: out,
    settings: { t_vid: st?.t_vid ?? 10, t_cr: st?.t_cr ?? 20, own_kw: st?.own_kw ?? "artphro" },
    states: states ?? [],
  };
}
