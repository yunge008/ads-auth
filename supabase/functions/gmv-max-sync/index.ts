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
      await _sleep(150);
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

// Step 1: list all GMV Max campaigns for an advertiser (PRODUCT_GMV_MAX).
// Returns id + name + operation_status (ENABLE/DISABLE).
export type CampaignInfo = { id: string; name: string; operation_status: string };
export async function fetchCampaigns(
  token: string,
  advertiser_id: string,
  _ttGet: typeof ttGet = ttGet,
  _ensureTime?: TimeBudgetChecker,
): Promise<CampaignInfo[]> {
  const out: CampaignInfo[] = [];
  const seen = new Set<string>();
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
      if (cid == null) continue;
      const id = String(cid);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: String(c.campaign_name ?? c.name ?? ""),
        operation_status: String(c.operation_status ?? ""),
      });
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
    ? [
        "creative_delivery_status", "cost", "orders", "gross_revenue",
        "product_impressions", "product_clicks", "currency",
        "ad_video_view_rate_2s", "ad_video_view_rate_6s",
        "ad_video_view_rate_p25", "ad_video_view_rate_p50",
        "ad_video_view_rate_p75", "ad_video_view_rate_p100",
      ]
    : ["cost", "orders", "gross_revenue"]);
  let activeMetrics = [...selectedMetrics];
  const filtering = JSON.stringify({ ...extraFilter });
  for (let i = 0; i < 100; i++) {
    _ensureTime?.();
    const params: Record<string, string> = {
      advertiser_id,
      store_ids: JSON.stringify([store_id]),
      dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify(activeMetrics),
      start_date: start,
      end_date: end,
      page: String(page),
      page_size: String(page_size),
      filtering,
    };
    let data: Record<string, unknown>;
    try {
      data = await _ttGet(token, "/gmv_max/report/get/", params);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const m = msg.match(/Invalid metric\(s\):\s*'\[([^\]]+)\]'/);
      if (m) {
        const bad = m[1].split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        const next = activeMetrics.filter((x) => !bad.includes(x));
        if (next.length && next.length < activeMetrics.length) {
          activeMetrics = next;
          continue; // retry same page with reduced metrics
        }
      }
      throw err;
    }
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
      campaign_ids?: string[];
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
    const presetCampaignIds = (body.campaign_ids ?? []).map(String).filter(Boolean);
    const hasPresetCampaigns = presetCampaignIds.length > 0;

    const db = admin();
    const [{ data: conns, error: ce }, { data: acRows, error: ae }] = await Promise.all([
      db.from("tiktok_connections").select("*"),
      db.from("advertiser_countries").select("advertiser_id, country, shop_id, advertiser_name"),
    ]);
    if (ce) throw new Error(ce.message);
    if (ae) throw new Error(ae.message);

    const tokenByAdv = new Map<string, string>();
    for (const c of (conns ?? []) as ConnRow[])
      for (const id of c.advertiser_ids)
        if (!tokenByAdv.has(id)) tokenByAdv.set(id, c.access_token);
    const countryByAdv = new Map<string, string>();
    const shopByAdv = new Map<string, string>();
    const nameByAdv = new Map<string, string>();
    for (const r of (acRows ?? []) as { advertiser_id: string; country: string; shop_id: string | null; advertiser_name: string | null }[]) {
      countryByAdv.set(r.advertiser_id, r.country);
      if (r.shop_id) shopByAdv.set(r.advertiser_id, r.shop_id);
      if (r.advertiser_name) nameByAdv.set(r.advertiser_id, r.advertiser_name);
    }

    const requested = filterIds && filterIds.length ? filterIds : [...tokenByAdv.keys()];
    const targets = requested.filter((id) => tokenByAdv.has(id) && shopByAdv.has(id));
    const skipped = requested.filter((id) => tokenByAdv.has(id) && !shopByAdv.has(id));
    const windows = splitWindows(start_date, end_date, 30);

    // Phase 0: fetch & upsert missing advertiser_name (one /advertiser/info/ call per token).
    const missingNameByToken = new Map<string, string[]>();
    for (const adv of targets) {
      if (nameByAdv.has(adv)) continue;
      const tok = tokenByAdv.get(adv)!;
      const arr = missingNameByToken.get(tok) ?? [];
      arr.push(adv);
      missingNameByToken.set(tok, arr);
    }
    if (missingNameByToken.size > 0) {
      const nameUpserts: { advertiser_id: string; advertiser_name: string; country: string }[] = [];
      for (const [tok, ids] of missingNameByToken) {
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          try {
            const data = await ttGet(tok, "/advertiser/info/", {
              advertiser_ids: JSON.stringify(batch),
              fields: JSON.stringify(["advertiser_id", "name", "company"]),
            });
            const list = (data.list ?? data) as Array<Record<string, unknown>> | Record<string, unknown>;
            const arr = Array.isArray(list) ? list : [];
            for (const it of arr) {
              const id = String(it.advertiser_id ?? it.id ?? "");
              if (!id) continue;
              const nm = String(it.advertiser_name ?? it.name ?? it.company ?? id);
              nameByAdv.set(id, nm);
              nameUpserts.push({ advertiser_id: id, advertiser_name: nm, country: countryByAdv.get(id) ?? "" });
            }
          } catch (err) {
            console.error("advertiser/info", (err as Error).message);
          }
        }
      }
      if (nameUpserts.length) {
        const { error } = await db
          .from("advertiser_countries")
          .upsert(nameUpserts, { onConflict: "advertiser_id" });
        if (error) console.error("upsert advertiser_name", error.message);
      }
    }


    const errors: { advertiser_id: string; window?: string; error: string }[] = [];
    for (const id of skipped) errors.push({ advertiser_id: id, error: "缺少店铺ID（shop_id），已跳过" });
    const upsertRows: Record<string, unknown>[] = [];
    
    const batchStats: {
      advertiser_id: string;
      campaigns: number;
      campaigns_rank: number;
      group_batches: number;
      creative_calls: number;
      rows: number;
      rows_max_batch: number;
      saturated: boolean;
    }[] = [];

    const processedAdvertisers: string[] = [];
    let stoppedBeforeTimeout:
      | { advertiser_id: string; remaining_campaign_ids: string[]; remaining_advertiser_ids: string[] }
      | null = null;

    // Phase 1: always fetch campaigns to get name + operation_status (cheap, 1 call/account).
    // Resume mode filters to preset campaign_ids but still gets meta.
    const campaignsByAdv = new Map<string, CampaignInfo[]>();
    const phase1Failed = new Set<string>();
    let phase1Stopped = false;
    const presetCidSet = new Set(presetCampaignIds);
    for (const adv of targets) {
      try {
        ensureTime(`phase1 ${adv}`);
        const tok = tokenByAdv.get(adv)!;
        let cs = await fetchCampaigns(tok, adv, ttGet, () => ensureTime(`phase1 ${adv} campaigns`));
        if (hasPresetCampaigns) {
          const filtered = cs.filter((c) => presetCidSet.has(c.id));
          const seen = new Set(filtered.map((c) => c.id));
          for (const id of presetCampaignIds) {
            if (!seen.has(id)) filtered.push({ id, name: "", operation_status: "" });
          }
          cs = filtered;
        }
        campaignsByAdv.set(adv, cs);
      } catch (err) {
        if (err instanceof TimeBudgetExceeded) {
          stoppedBeforeTimeout = {
            advertiser_id: "",
            remaining_campaign_ids: [],
            remaining_advertiser_ids: targets.filter(
              (id) => !campaignsByAdv.has(id) && !phase1Failed.has(id),
            ),
          };
          phase1Stopped = true;
          break;
        }
        phase1Failed.add(adv);
        errors.push({ advertiser_id: adv, error: `campaign/get: ${(err as Error).message}` });
      }
    }

    const sortedTargets = [...campaignsByAdv.keys()].sort(
      (a, b) => campaignsByAdv.get(a)!.length - campaignsByAdv.get(b)!.length,
    );
    const rankByAdv = new Map<string, number>();
    sortedTargets.forEach((id, i) => rankByAdv.set(id, i + 1));

    const runAdvertiser = async (adv: string, processedCampaigns: Set<string>): Promise<void> => {
      ensureTime(`advertiser ${adv} start`);
      const tok = tokenByAdv.get(adv)!;
      const shopId = shopByAdv.get(adv)!;
      const campaigns = campaignsByAdv.get(adv) ?? [];
      const campaignIds = campaigns.map((c) => c.id);
      const campaignMeta = new Map<string, CampaignInfo>();
      for (const c of campaigns) campaignMeta.set(c.id, c);

      // Delete-then-insert: purge existing rows for (advertiser, campaigns, date-range)
      // so stale records from prior pulls don't linger when a VID disappears.
      if (campaignIds.length) {
        for (const cidBatch of chunk(campaignIds, 100)) {
          const { error } = await db
            .from("gmv_max_vid_daily")
            .delete()
            .eq("advertiser_id", adv)
            .in("campaign_id", cidBatch)
            .gte("stat_date", start_date)
            .lte("stat_date", end_date);
          if (error) throw new Error(`delete stale: ${error.message}`);
        }
      }

      const groupCache = new Map<string, Set<string>>();
      let groupBatches = 0;
      let creativeCalls = 0;
      let totalRows = 0;
      let maxRows = 0;
      let saturated = false;

      const groupStart = addDays(end_date, -364);
      // Campaign-centric group discovery + creative fetch so timeout resume can
      // advance by completed campaign instead of repeating the whole country.
      for (const cid of campaignIds) {
        let groupIds = Array.from(groupCache.get(cid) ?? []);
        if (!groupCache.has(cid)) {
          ensureTime(`advertiser ${adv} group discovery`);
          groupBatches++;
          try {
            const groups = await fetchReport(
              tok, adv, shopId, groupStart, end_date,
              ["campaign_id", "item_group_id"],
              { campaign_ids: [cid] },
              undefined,
              ttGet,
              () => ensureTime(`advertiser ${adv} group pages`),
            );
            const set = new Set<string>();
            for (const r of groups) {
              const dims = (r.dimensions ?? {}) as Record<string, unknown>;
              const gid = String(dims.item_group_id ?? "");
              if (gid) set.add(gid);
            }
            groupCache.set(cid, set);
            groupIds = Array.from(set);
          } catch (err) {
            if (err instanceof TimeBudgetExceeded) throw err;
            errors.push({
              advertiser_id: adv,
              error: `group campaign[${cid}]: ${(err as Error).message}`,
            });
            processedCampaigns.add(cid);
            continue;
          }
        }
        if (groupIds.length === 0) {
          processedCampaigns.add(cid);
          continue;
        }
        let cidFailedNonTimeout = false;
        for (const [s, e] of windows) {
          for (const igidBatch of chunk(groupIds, 100)) {
            ensureTime(`advertiser ${adv} creative fetch`);
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
                const numOrNull = (k: string) => mets[k] == null ? null : Number(mets[k]);
                const strOrNull = (k: string) => mets[k] == null ? null : String(mets[k]);
                const rowCid = String(dims.campaign_id ?? "");
                const meta = campaignMeta.get(rowCid);
                upsertRows.push({
                  country: countryByAdv.get(adv) ?? "",
                  advertiser_id: adv,
                  campaign_id: rowCid,
                  campaign_name: meta?.name ?? null,
                  campaign_operation_status: meta?.operation_status ?? null,
                  item_group_id: String(dims.item_group_id ?? ""),
                  vid,

                  stat_date: String(dims.stat_time_day ?? "").slice(0, 10),
                  creative_delivery_status: strOrNull("creative_delivery_status"),
                  currency: strOrNull("currency"),
                  tt_account_name: strOrNull("tt_account_name"),
                  tt_account_authorization_type: strOrNull("tt_account_authorization_type"),
                  shop_content_type: strOrNull("shop_content_type"),
                  ad_video_view_rate_2s: numOrNull("ad_video_view_rate_2s"),
                  ad_video_view_rate_6s: numOrNull("ad_video_view_rate_6s"),
                  ad_video_view_rate_p25: numOrNull("ad_video_view_rate_p25"),
                  ad_video_view_rate_p50: numOrNull("ad_video_view_rate_p50"),
                  ad_video_view_rate_p75: numOrNull("ad_video_view_rate_p75"),
                  ad_video_view_rate_p100: numOrNull("ad_video_view_rate_p100"),
                  cost,
                  gross_revenue: rev,
                  orders,
                  product_impressions: imps,
                  product_clicks: clks,
                  pulled_at: nowIso,
                });
              }
            } catch (err) {
              if (err instanceof TimeBudgetExceeded) throw err;
              cidFailedNonTimeout = true;
              errors.push({
                advertiser_id: adv,
                window: `${s}~${e}`,
                error: `creative campaign[${cid}] groups[${igidBatch[0]}...x${igidBatch.length}]: ${(err as Error).message}`,
              });
            }
          }
        }
        // Mark cid done whether all-good or all-windows-failed-non-timeout (avoid infinite retry).
        void cidFailedNonTimeout;
        processedCampaigns.add(cid);
      }
      batchStats.push({
        advertiser_id: adv,
        campaigns: campaigns.length,
        campaigns_rank: rankByAdv.get(adv) ?? 0,
        group_batches: groupBatches,
        creative_calls: creativeCalls,
        rows: totalRows,
        rows_max_batch: maxRows,
        saturated,
      });
    };

    if (!phase1Stopped) {
      for (let i = 0; i < sortedTargets.length; i++) {
        const adv = sortedTargets[i];
        const processedCampaigns = new Set<string>();
        try {
          await runAdvertiser(adv, processedCampaigns);
          processedAdvertisers.push(adv);
        } catch (err) {
          if (err instanceof TimeBudgetExceeded) {
            const allCids = (campaignsByAdv.get(adv) ?? []).map((c) => c.id);
            stoppedBeforeTimeout = {
              advertiser_id: adv,
              remaining_campaign_ids: allCids.filter((c) => !processedCampaigns.has(c)),
              remaining_advertiser_ids: sortedTargets.slice(i + 1),
            };
            break;
          }
          errors.push({ advertiser_id: adv, error: (err as Error).message });
        }
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

    // Phase 3: backfill static VID meta (title / tt_account_name / authorization_type /
    // shop_content_type). Only fetched for VIDs not yet in gmv_max_vid_meta.
    let metaUpserted = 0;
    const metaErrors: { advertiser_id: string; error: string }[] = [];
    try {
      // collect unique (adv, cid, igid, vid) seen this run
      const seenTuples = new Map<string, { adv: string; cid: string; igid: string; vid: string }>();
      for (const r of upsertRows) {
        const adv = String(r.advertiser_id ?? "");
        const cid = String(r.campaign_id ?? "");
        const igid = String(r.item_group_id ?? "");
        const vid = String(r.vid ?? "");
        if (!adv || !cid || !igid || !vid) continue;
        const k = `${adv}|${cid}|${igid}|${vid}`;
        if (!seenTuples.has(k)) seenTuples.set(k, { adv, cid, igid, vid });
      }
      const allVids = Array.from(new Set([...seenTuples.values()].map((t) => t.vid)));
      // find existing VIDs in batches
      const existing = new Set<string>();
      for (let i = 0; i < allVids.length; i += 500) {
        const slice = allVids.slice(i, i + 500);
        const { data, error } = await db
          .from("gmv_max_vid_meta")
          .select("vid")
          .in("vid", slice);
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as { vid: string }[]) existing.add(row.vid);
      }
      // group missing VIDs by (adv, cid, igid)
      type Pair = { cid: string; igid: string; vids: Set<string> };
      const missingByAdv = new Map<string, Map<string, Pair>>();
      for (const t of seenTuples.values()) {
        if (existing.has(t.vid)) continue;
        let perAdv = missingByAdv.get(t.adv);
        if (!perAdv) { perAdv = new Map(); missingByAdv.set(t.adv, perAdv); }
        const key = `${t.cid}|${t.igid}`;
        let pair = perAdv.get(key);
        if (!pair) { pair = { cid: t.cid, igid: t.igid, vids: new Set() }; perAdv.set(key, pair); }
        pair.vids.add(t.vid);
      }
      const metaRows: Record<string, unknown>[] = [];
      const metaEnd = end_date;
      const metaStart = addDays(metaEnd, -364);
      const META_METRICS = ["title", "tt_account_name", "tt_account_authorization_type", "shop_content_type"];
      for (const [adv, perAdv] of missingByAdv) {
        const tok = tokenByAdv.get(adv);
        const shopId = shopByAdv.get(adv);
        if (!tok || !shopId) continue;
        for (const pair of perAdv.values()) {
          try {
            ensureTime(`meta ${adv}`);
            const list = await fetchReport(
              tok, adv, shopId, metaStart, metaEnd,
              ["item_id"],
              { campaign_ids: [pair.cid], item_group_ids: [pair.igid] },
              META_METRICS,
              ttGet,
              () => ensureTime(`meta ${adv} pages`),
            );
            for (const r of list) {
              const dims = (r.dimensions ?? {}) as Record<string, unknown>;
              const mets = (r.metrics ?? {}) as Record<string, unknown>;
              const vid = String(dims.item_id ?? "");
              if (!vid || !pair.vids.has(vid)) continue;
              const s = (k: string) => mets[k] == null ? null : String(mets[k]);
              metaRows.push({
                vid,
                campaign_id: pair.cid,
                item_group_id: pair.igid,
                advertiser_id: adv,
                title: s("title"),
                tt_account_name: s("tt_account_name"),
                tt_account_authorization_type: s("tt_account_authorization_type"),
                shop_content_type: s("shop_content_type"),
                pulled_at: nowIso,
              });
            }
          } catch (err) {
            if (err instanceof TimeBudgetExceeded) throw err;
            metaErrors.push({
              advertiser_id: adv,
              error: `meta campaign[${pair.cid}] group[${pair.igid}]: ${(err as Error).message}`,
            });
          }
        }
      }
      if (metaRows.length) {
        const CHUNK = 500;
        for (let i = 0; i < metaRows.length; i += CHUNK) {
          const batch = metaRows.slice(i, i + CHUNK);
          const { error } = await db
            .from("gmv_max_vid_meta")
            .upsert(batch, { onConflict: "vid" });
          if (error) throw new Error(error.message);
          metaUpserted += batch.length;
        }
      }
    } catch (err) {
      if (!(err instanceof TimeBudgetExceeded)) {
        metaErrors.push({ advertiser_id: "", error: `meta phase: ${(err as Error).message}` });
      }
    }
    for (const e of metaErrors) errors.push(e);

    const advertiser_names: Record<string, string> = {};
    for (const adv of targets) {
      const nm = nameByAdv.get(adv);
      if (nm) advertiser_names[adv] = nm;
    }

    return new Response(
      JSON.stringify({
        mode,
        start_date,
        end_date,
        windows: windows.length,
        advertisers: targets.length,
        processed_advertisers: processedAdvertisers.length,
        remaining_advertiser_ids: stoppedBeforeTimeout
          ? [
              ...(stoppedBeforeTimeout.advertiser_id ? [stoppedBeforeTimeout.advertiser_id] : []),
              ...stoppedBeforeTimeout.remaining_advertiser_ids,
            ]
          : [],
        remaining_campaign_ids: stoppedBeforeTimeout?.remaining_campaign_ids ?? [],
        batch_size: batchSize,
        max_runtime_ms: maxRuntimeMs,
        stopped_before_timeout: stoppedBeforeTimeout,
        upserted,
        meta_upserted: metaUpserted,
        batch_stats: batchStats,
        advertiser_names,
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
