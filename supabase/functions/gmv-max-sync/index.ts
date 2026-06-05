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

async function fetchReport(
  token: string,
  advertiser_id: string,
  store_id: string,
  start: string,
  end: string,
): Promise<RawRow[]> {
  const out: RawRow[] = [];
  let page = 1;
  const page_size = 200;
  for (let i = 0; i < 50; i++) {
    const url = new URL(`${TT}/gmv_max/report/get/`);
    url.searchParams.set("advertiser_id", advertiser_id);
    url.searchParams.set("store_ids", JSON.stringify([store_id]));
    url.searchParams.set(
      "dimensions",
      JSON.stringify(["campaign_id", "item_group_id", "item_id", "stat_time_day"]),
    );
    url.searchParams.set(
      "metrics",
      JSON.stringify([
        "creative_delivery_status",
        "cost",
        "orders",
        "gross_revenue",
        "product_impressions",
        "product_clicks",
      ]),
    );
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", end);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(page_size));
    const res = await fetch(url, { headers: { "Access-Token": token } });
    const j = await res.json().catch(() => ({}));
    if (j.code !== 0) throw new Error(`gmv_max/report/get: ${j.message ?? "unknown"}`);
    const list = (j.data?.list ?? []) as RawRow[];
    out.push(...list);
    const total = j.data?.page_info?.total_number ?? 0;
    if (page * page_size >= Number(total) || list.length === 0) break;
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
      db.from("advertiser_countries").select("advertiser_id, country"),
    ]);
    if (ce) throw new Error(ce.message);
    if (ae) throw new Error(ae.message);

    const tokenByAdv = new Map<string, string>();
    for (const c of (conns ?? []) as ConnRow[])
      for (const id of c.advertiser_ids)
        if (!tokenByAdv.has(id)) tokenByAdv.set(id, c.access_token);
    const countryByAdv = new Map<string, string>(
      ((acRows ?? []) as { advertiser_id: string; country: string }[]).map((r) => [
        r.advertiser_id,
        r.country,
      ]),
    );

    const targets = (filterIds && filterIds.length ? filterIds : [...tokenByAdv.keys()]).filter(
      (id) => tokenByAdv.has(id),
    );
    const windows = splitWindows(start_date, end_date, 30);

    const errors: { advertiser_id: string; window?: string; error: string }[] = [];
    const upsertRows: Record<string, unknown>[] = [];
    const nowIso = new Date().toISOString();

    for (const adv of targets) {
      const tok = tokenByAdv.get(adv)!;
      for (const [s, e] of windows) {
        try {
          const list = await fetchReport(tok, adv, s, e);
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
              campaign_id: String(dims.campaign_id ?? ""),
              item_group_id: String(dims.item_group_id ?? ""),
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
          errors.push({ advertiser_id: adv, window: `${s}~${e}`, error: (err as Error).message });
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
