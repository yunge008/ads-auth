// Sync GMV Max VID-level daily report into gmv_max_vid_daily.
// Body: {
//   start_date?: 'YYYY-MM-DD', end_date?: 'YYYY-MM-DD',
//   advertiser_ids?: string[],
//   mode?: 'backfill' | 'incremental' | 'custom' (default: 'custom'),
//   batch_size?: number (default 20, max 100),
// }
// - backfill:    last 30 days
// - incremental: last 3 days
// - custom:      requires start_date / end_date
// Serial single-token sync. It stops before the Edge runtime hard timeout and
// returns the remaining advertiser_ids so the caller can resume without a 504.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api/v1.3";

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(() => r(), ms));

class TimeBudgetExceeded extends Error {
  constructor(stage: string) {
    super(`time budget exceeded at ${stage}`);
    this.name = "TimeBudgetExceeded";
  }
}

function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  const t1 = new Date(a + "T00:00:00Z").getTime();
  const t2 = new Date(b + "T00:00:00Z").getTime();
  return Math.round((t2 - t1) / 86400000);
}
function splitWindows(start: string, end: string, max = 30): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cur = start;
  while (daysBetween(cur, end) >= 0) {
    const next = addDays(cur, max - 1);
    const stop = daysBetween(next, end) > 0 ? next : end;
    out.push([cur, stop]);
    cur = addDays(stop, 1);
  }
  return out;
}
function safeDiv(num: number, den: number): number | null {
  if (!den || den === 0) return null;
  return num / den;
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type RawRow = Record<string, unknown>;
type TimeBudgetChecker = () => void;

// Rate-limited (≤ ~3 QPS) + retry on "Too many requests" with exponential backoff.
// Other errors fail fast (don't waste QPD on bad filters / invalid metrics).
export async function ttGet(
  token: string,
  path: string,
  params: Record<string, string>,
  retries = 5,
  _sleep: (ms: number) => Promise<void> = sleep,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const url = new URL(`${TT}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    let j: Record<string, unknown>;
    try {
      const res = await fetch(url, { headers: { "Access-Token": token }, signal: controller.signal });
      j = await res.json().catch(() => ({}));
    } catch (err) {
      if (attempt < retries - 1) {
        await _sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`${path}: network/timeout ${(err as Error).message}`);
    } finally {
      clearTimeout(timeoutId);
    }
    if (j.code === 0) {
      await _sleep(300);
      return (j.data ?? {}) as Record<string, unknown>;
    }
    const msg = String(j.message ?? "");
    const isRate = msg.includes("Too many requests") || j.code === 40100 || j.code === 50002;
    if (isRate && attempt < retries - 1) {
      await _sleep(3000 * Math.pow(2, attempt));
      continue;
    }
    throw new Error(`${path}: ${msg || "unknown"}`);
  }
  throw new Error(`${path}: max retries exceeded`);
}

// Step 1: list all GMV Max campaign IDs for an advertiser (PRODUCT_GMV_MAX).
export async function fetchCampaigns(
  token: string,
  advertiser_id: string,
  _ttGet: typeof ttGet = ttGet,
  _ensureTime?: TimeBudgetChecker,
): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  const page_size = 100;
  const filtering = JSON.stringify({ gmv_max_promotion_types: ["PRODUCT_GMV_MAX"] });
  for (let i = 0; i < 50; i++) {
    _ensureTime?.();
    const data = await _ttGet(token, "/gmv_max/campaign/get/", {
      advertiser_id,
      filtering,
      page: String(page),
      page_size: String(page_size),
    });
    const list = (data.list ?? []) as Array<Record<string, unknown>>;
    for (const c of list) {
      const cid = c.campaign_id ?? c.id;
      if (cid != null) ids.push(String(cid));
    }
    const pi = (data.page_info ?? {}) as Record<string, unknown>;
    const totalPage = Number(pi.total_page ?? 0);
    const total = Number(pi.total_number ?? 0);
    if (list.length === 0) break;
    if (totalPage > 0 && page >= totalPage) break;
    if (!totalPage && total > 0 && page * page_size >= total) break;
    page++;
  }
  return Array.from(new Set(ids));
}

// Generic paged report fetch. filtering MUST be an object (not array).
// gmv_max_promotion_types is NOT supported when the request is already scoped
// to specific campaigns/item_groups, nor at creative (item_id) level.
export async function fetchReport(
  token: string,
  advertiser_id: string,
  store_id: string,
  start: string,
  end: string,
  dimensions: string[],
  extraFilter: Record<string, unknown> = {},
  metrics?: string[],
  _ttGet: typeof ttGet = ttGet,
  _ensureTime?: TimeBudgetChecker,
): Promise<RawRow[]> {
  const out: RawRow[] = [];
  const seen = new Set<string>();
  let page = 1;
  const page_size = 1000;
  const selectedMetrics = metrics ?? (dimensions.includes("item_id")
    ? ["creative_delivery_status", "cost", "orders", "gross_revenue", "product_impressions", "product_clicks"]
    : ["cost", "orders", "gross_revenue"]);
  const filtering = JSON.stringify({ ...extraFilter });
  for (let i = 0; i < 100; i++) {
    _ensureTime?.();
    const params: Record<string, string> = {
      advertiser_id,
      store_ids: JSON.stringify([store_id]),
      dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify(selectedMetrics),
      start_date: start,
      end_date: end,
      page: String(page),
      page_size: String(page_size),
      filtering,
    };
    const data = await _ttGet(token, "/gmv_max/report/get/", params);
    const list = (data.list ?? []) as RawRow[];
    for (const row of list) {
      const key = JSON.stringify((row.dimensions ?? row) as Record<string, unknown>);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    const pi = (data.page_info ?? {}) as Record<string, unknown>;
    const totalPage = Number(pi.total_page ?? 0);
    const total = Number(pi.total_number ?? 0);
    if (list.length === 0) break;
    if (totalPage > 0 && page >= totalPage) break;
    if (!totalPage && total > 0 && page * page_size >= total) break;
    page++;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "material-performance");
    const body = (await req.json().catch(() => ({}))) as {
      start_date?: string;
      end_date?: string;
      advertiser_ids?: string[];
      mode?: "backfill" | "incremental" | "custom";
      batch_size?: number;
      max_runtime_ms?: number;
    };
    const startedAt = Date.now();
    const maxRuntimeMs = Math.max(30000, Math.min(120000, Number(body.max_runtime_ms ?? 110000)));
    const ensureTime = (stage: string) => {
      if (Date.now() - startedAt > maxRuntimeMs) throw new TimeBudgetExceeded(stage);
    };
    const mode = body.mode ?? "custom";
    const today = new Date().toISOString().slice(0, 10);
    let start_date = body.start_date ?? "";
    let end_date = body.end_date ?? "";
    if (mode === "backfill") {
      start_date = addDays(today, -30);
      end_date = today;
    } else if (mode === "incremental") {
      start_date = addDays(today, -3);
      end_date = today;
    }
    if (!start_date || !end_date) throw new Error("start_date / end_date 必填 (或使用 mode=backfill|incremental)");

    const batchSize = Math.max(1, Math.min(100, Number(body.batch_size ?? 20)));
    const filterIds = body.advertiser_ids;

    const db = admin();
    const [{ data: conns, error: ce }, { data: acRows, error: ae }] = await Promise.all([
      db.from("tiktok_connections").select("*"),
      db.from("advertiser_countries").select("advertiser_id, country, shop_id"),
    ]);
    if (ce) throw new Error(ce.message);
    if (ae) throw new Error(ae.message);

    const tokenByAdv = new Map<string, string>();
    for (const c of (conns ?? []) as ConnRow[])
      for (const id of c.advertiser_ids)
        if (!tokenByAdv.has(id)) tokenByAdv.set(id, c.access_token);
    const countryByAdv = new Map<string, string>();
    const shopByAdv = new Map<string, string>();
    for (const r of (acRows ?? []) as { advertiser_id: string; country: string; shop_id: string | null }[]) {
      countryByAdv.set(r.advertiser_id, r.country);
      if (r.shop_id) shopByAdv.set(r.advertiser_id, r.shop_id);
    }

    const requested = filterIds && filterIds.length ? filterIds : [...tokenByAdv.keys()];
    const targets = requested.filter((id) => tokenByAdv.has(id) && shopByAdv.has(id));
    const skipped = requested.filter((id) => tokenByAdv.has(id) && !shopByAdv.has(id));
    const windows = splitWindows(start_date, end_date, 30);

    const errors: { advertiser_id: string; window?: string; error: string }[] = [];
    for (const id of skipped) errors.push({ advertiser_id: id, error: "缺少店铺ID（shop_id），已跳过" });
    const upsertRows: Record<string, unknown>[] = [];
    const nowIso = new Date().toISOString();
    const batchStats: {
      advertiser_id: string;
      campaigns: number;
      group_batches: number;
      creative_calls: number;
      rows: number;
      rows_max_batch: number;
      saturated: boolean;
    }[] = [];

    const processedAdvertisers: string[] = [];
    let stoppedBeforeTimeout: { reason: string; remaining_advertiser_ids: string[] } | null = null;

    const runAdvertiser = async (adv: string): Promise<void> => {
      ensureTime(`advertiser ${adv} start`);
      const tok = tokenByAdv.get(adv)!;
      const shopId = shopByAdv.get(adv)!;

      let campaigns: string[] = [];
      try {
        campaigns = await fetchCampaigns(tok, adv, ttGet, () => ensureTime(`advertiser ${adv} campaigns`));
      } catch (err) {
        if (err instanceof TimeBudgetExceeded) throw err;
        errors.push({ advertiser_id: adv, error: `campaign/get: ${(err as Error).message}` });
        return;
      }
      if (campaigns.length === 0) return;

      const campaignGroups = new Map<string, Set<string>>();
      const campaignBatches = chunk(campaigns, batchSize);
      let groupBatches = 0;
      let creativeCalls = 0;
      let totalRows = 0;
      let maxRows = 0;
      let saturated = false;

      const groupStart = addDays(end_date, -364);
      for (const batch of campaignBatches) {
        ensureTime(`advertiser ${adv} group discovery`);
        groupBatches++;
        try {
          const groups = await fetchReport(
            tok, adv, shopId, groupStart, end_date,
            ["campaign_id", "item_group_id"],
            { campaign_ids: batch },
            undefined,
            ttGet,
            () => ensureTime(`advertiser ${adv} group pages`),
          );
          for (const r of groups) {
            const dims = (r.dimensions ?? {}) as Record<string, unknown>;
            const cid = String(dims.campaign_id ?? "");
            const gid = String(dims.item_group_id ?? "");
            if (!cid || !gid) continue;
            if (!campaignGroups.has(cid)) campaignGroups.set(cid, new Set<string>());
            campaignGroups.get(cid)!.add(gid);
          }
        } catch (err) {
          if (err instanceof TimeBudgetExceeded) throw err;
          errors.push({
            advertiser_id: adv,
            error: `group batch[${batch[0]}...x${batch.length}]: ${(err as Error).message}`,
          });
        }
      }

      for (const [s, e] of windows) {
        for (const cid of campaigns) {
          ensureTime(`advertiser ${adv} creative fetch`);
          const groupIds = Array.from(campaignGroups.get(cid) ?? []);
          if (groupIds.length === 0) continue;
          for (const igidBatch of chunk(groupIds, 100)) {
            creativeCalls++;
            try {
              const list = await fetchReport(
                tok, adv, shopId, s, e,
                ["campaign_id", "item_group_id", "item_id", "stat_time_day"],
                { campaign_ids: [cid], item_group_ids: igidBatch },
                undefined,
                ttGet,
                () => ensureTime(`advertiser ${adv} creative pages`),
              );
              totalRows += list.length;
              if (list.length > maxRows) maxRows = list.length;
              if (list.length >= 95000) saturated = true;
              for (const r of list) {
                const dims = (r.dimensions ?? {}) as Record<string, unknown>;
                const mets = (r.metrics ?? {}) as Record<string, unknown>;
                const cost = Number(mets.cost ?? 0) || 0;
                const rev = Number(mets.gross_revenue ?? 0) || 0;
                const orders = Number(mets.orders ?? 0) || 0;
                const imps = Number(mets.product_impressions ?? 0) || 0;
                const clks = Number(mets.product_clicks ?? 0) || 0;
                const vid = String(dims.item_id ?? "");
                if (!vid) continue;
                upsertRows.push({
                  country: countryByAdv.get(adv) ?? "",
                  advertiser_id: adv,
                  campaign_id: String(dims.campaign_id ?? ""),
                  item_group_id: String(dims.item_group_id ?? ""),
                  vid,
                  stat_date: String(dims.stat_time_day ?? "").slice(0, 10),
                  creative_delivery_status: mets.creative_delivery_status == null ? null : String(mets.creative_delivery_status),
                  cost,
                  gross_revenue: rev,
                  orders,
                  product_impressions: imps,
                  product_clicks: clks,
                  roi: safeDiv(rev, cost),
                  ctr: safeDiv(clks, imps),
                  cvr: safeDiv(orders, clks),
                  cpm: safeDiv(cost, imps) === null ? null : (cost / imps) * 1000,
                  raw_payload: r,
                  pulled_at: nowIso,
                });
              }
            } catch (err) {
              if (err instanceof TimeBudgetExceeded) throw err;
              errors.push({
                advertiser_id: adv,
                window: `${s}~${e}`,
                error: `creative campaign[${cid}] groups[${igidBatch[0]}...x${igidBatch.length}]: ${(err as Error).message}`,
              });
            }
          }
        }
      }
      batchStats.push({
        advertiser_id: adv,
        campaigns: campaigns.length,
        group_batches: groupBatches,
        creative_calls: creativeCalls,
        rows: totalRows,
        rows_max_batch: maxRows,
        saturated,
      });
    };

    for (let i = 0; i < targets.length; i++) {
      const adv = targets[i];
      try {
        await runAdvertiser(adv);
        processedAdvertisers.push(adv);
      } catch (err) {
        if (err instanceof TimeBudgetExceeded) {
          stoppedBeforeTimeout = {
            reason: err.message,
            remaining_advertiser_ids: targets.slice(i),
          };
          break;
        }
        errors.push({ advertiser_id: adv, error: (err as Error).message });
      }
    }

    let upserted = 0;
    if (upsertRows.length) {
      const CHUNK = 500;
      for (let i = 0; i < upsertRows.length; i += CHUNK) {
        const batch = upsertRows.slice(i, i + CHUNK);
        const { error } = await db
          .from("gmv_max_vid_daily")
          .upsert(batch, {
            onConflict: "advertiser_id,campaign_id,item_group_id,vid,stat_date",
          });
        if (error) throw new Error(error.message);
        upserted += batch.length;
      }
    }

    return new Response(
      JSON.stringify({
        mode,
        start_date,
        end_date,
        windows: windows.length,
        advertisers: targets.length,
        processed_advertisers: processedAdvertisers.length,
        remaining_advertiser_ids: stoppedBeforeTimeout?.remaining_advertiser_ids ?? [],
        batch_size: batchSize,
        max_runtime_ms: maxRuntimeMs,
        stopped_before_timeout: stoppedBeforeTimeout,
        upserted,
        batch_stats: batchStats,
        errors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("gmv-max-sync", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
