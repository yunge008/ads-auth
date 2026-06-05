// Sync GMV Max VID-level daily report into gmv_max_vid_daily.
// Body: { start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD', advertiser_ids?: string[] }
// Auto-splits into 30-day windows. Uses /gmv_max/report/get/ with item_id dimension.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api/v1.3";

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
    const stop = daysBetween(next, end) > 0 ? end : next;
    out.push([cur, stop]);
    cur = addDays(stop, 1);
  }
  return out;
}
function safeDiv(num: number, den: number): number | null {
  if (!den || den === 0) return null;
  return num / den;
}

type RawRow = Record<string, unknown>;

async function ttGet(token: string, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`${TT}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "Access-Token": token } });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`${path}: ${j.message ?? "unknown"}`);
  return (j.data ?? {}) as Record<string, unknown>;
}

// Step 1: list all GMV Max campaign IDs for an advertiser (PRODUCT_GMV_MAX).
// /gmv_max/campaign/get/ requires filtering.gmv_max_promotion_types (enum: PRODUCT_GMV_MAX | LIVE_GMV_MAX).
export async function fetchCampaigns(
  token: string,
  advertiser_id: string,
  _ttGet: typeof ttGet = ttGet,
): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  const page_size = 100;
  const filtering = JSON.stringify({ gmv_max_promotion_types: ["PRODUCT_GMV_MAX"] });
  for (let i = 0; i < 50; i++) {
    const data = await ttGet(token, "/gmv_max/campaign/get/", {
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

// Generic paged report fetch. filtering MUST be an object (not array),
// always merged with gmv_max_promotion_types: ["PRODUCT"].
export async function fetchReport(
  token: string,
  advertiser_id: string,
  store_id: string,
  start: string,
  end: string,
  dimensions: string[],
  extraFilter: Record<string, unknown> = {},
  _ttGet: typeof ttGet = ttGet,
): Promise<RawRow[]> {
  const out: RawRow[] = [];
  let page = 1;
  const page_size = 200;
  const filtering = JSON.stringify({
    gmv_max_promotion_types: ["PRODUCT"],
    ...extraFilter,
  });
  for (let i = 0; i < 50; i++) {
    const params: Record<string, string> = {
      advertiser_id,
      store_ids: JSON.stringify([store_id]),
      dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify([
        "creative_delivery_status",
        "cost",
        "orders",
        "gross_revenue",
        "product_impressions",
        "product_clicks",
      ]),
      start_date: start,
      end_date: end,
      page: String(page),
      page_size: String(page_size),
      filtering,
    };
    const data = await _ttGet(token, "/gmv_max/report/get/", params);
    const list = (data.list ?? []) as RawRow[];
    out.push(...list);
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
    const { start_date, end_date, advertiser_ids: filterIds } = (await req.json()) as {
      start_date: string;
      end_date: string;
      advertiser_ids?: string[];
    };
    if (!start_date || !end_date) throw new Error("start_date / end_date 必填");

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

    for (const adv of targets) {
      const tok = tokenByAdv.get(adv)!;
      const shopId = shopByAdv.get(adv)!;

      // Step 1: pull all campaign IDs for this advertiser
      let campaigns: string[] = [];
      try {
        campaigns = await fetchCampaigns(tok, adv);
      } catch (err) {
        errors.push({ advertiser_id: adv, error: `campaign/get: ${(err as Error).message}` });
        continue;
      }
      if (campaigns.length === 0) continue;

      for (const [s, e] of windows) {
        // Step 2: per campaign, pull item_group_ids via report (item group level)
        const groupsByCampaign = new Map<string, Set<string>>();
        for (const cid of campaigns) {
          try {
            const list = await fetchReport(tok, adv, shopId, s, e,
              ["campaign_id", "item_group_id", "stat_time_day"],
              [{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([cid]) }],
            );
            const set = groupsByCampaign.get(cid) ?? new Set<string>();
            for (const r of list) {
              const dims = (r.dimensions ?? {}) as Record<string, unknown>;
              const igid = String(dims.item_group_id ?? "");
              if (igid) set.add(igid);
            }
            groupsByCampaign.set(cid, set);
          } catch (err) {
            errors.push({ advertiser_id: adv, window: `${s}~${e}`, error: `group ${cid}: ${(err as Error).message}` });
          }
        }

        // Step 3: per (campaign, item_group) pull creative-level VIDs
        for (const [cid, gset] of groupsByCampaign) {
          for (const igid of gset) {
            try {
              const list = await fetchReport(tok, adv, shopId, s, e,
                ["campaign_id", "item_group_id", "item_id", "stat_time_day"],
                [
                  { field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([cid]) },
                  { field_name: "item_group_ids", filter_type: "IN", filter_value: JSON.stringify([igid]) },
                ],
              );
              for (const r of list) {
                const dims = (r.dimensions ?? {}) as Record<string, unknown>;
                const mets = (r.metrics ?? {}) as Record<string, unknown>;
                const cost = Number(mets.cost ?? 0) || 0;
                const rev = Number(mets.gross_revenue ?? 0) || 0;
                const orders = Number(mets.orders ?? 0) || 0;
                const imps = Number(mets.product_impressions ?? 0) || 0;
                const clks = Number(mets.product_clicks ?? 0) || 0;
                upsertRows.push({
                  country: countryByAdv.get(adv) ?? "",
                  advertiser_id: adv,
                  campaign_id: String(dims.campaign_id ?? cid),
                  item_group_id: String(dims.item_group_id ?? igid),
                  vid: String(dims.item_id ?? ""),
                  stat_date: String(dims.stat_time_day ?? "").slice(0, 10),
                  creative_delivery_status: (mets.creative_delivery_status as string) ?? null,
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
              errors.push({ advertiser_id: adv, window: `${s}~${e}`, error: `creative ${cid}/${igid}: ${(err as Error).message}` });
            }
          }
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

    return new Response(
      JSON.stringify({
        windows: windows.length,
        advertisers: targets.length,
        upserted,
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
