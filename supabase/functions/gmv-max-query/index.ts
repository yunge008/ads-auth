// Query material performance: returns aggregated rows + daily series.
// Body: {
//   start_date, end_date,
//   countries?: string[], staff_names?: string[], source_types?: ('BD'|'EDITOR')[],
//   vids?: string[], merchant_skus?: string[], product_ids?: string[]
// }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

type StaffRow = { country: string; staff_name: string; vid: string; source_type: string; registered_sku: string | null };
type DailyRow = {
  country: string;
  advertiser_id: string;
  campaign_id: string;
  item_group_id: string;
  vid: string;
  stat_date: string;
  cost: number;
  gross_revenue: number;
  orders: number;
  product_impressions: number;
  product_clicks: number;
  creative_delivery_status: string | null;
};
type SkuRow = {
  country: string;
  product_id: string;
  merchant_sku: string;
  product_name: string | null;
};

function safeDiv(num: number, den: number): number | null {
  if (!den) return null;
  return num / den;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "material-performance");
    const body = (await req.json()) as {
      start_date: string;
      end_date: string;
      countries?: string[];
      staff_names?: string[];
      source_types?: string[];
      vids?: string[];
      merchant_skus?: string[];
      product_ids?: string[];
    };
    if (!body.start_date || !body.end_date) throw new Error("start_date / end_date 必填");

    const db = admin();

    // 1) Load staff_vid_map (primary)
    let mapQ = db.from("staff_vid_map").select("country, staff_name, vid, source_type, registered_sku");
    if (body.countries?.length) mapQ = mapQ.in("country", body.countries);
    if (body.staff_names?.length) mapQ = mapQ.in("staff_name", body.staff_names);
    if (body.source_types?.length) mapQ = mapQ.in("source_type", body.source_types);
    if (body.vids?.length) mapQ = mapQ.in("vid", body.vids);
    const { data: mapRows, error: mapErr } = await mapQ;
    if (mapErr) throw new Error(mapErr.message);
    const staff = (mapRows ?? []) as StaffRow[];
    const vidsInScope = Array.from(new Set(staff.map((s) => s.vid)));

    // 2) Load daily data for those vids in date range
    let daily: DailyRow[] = [];
    if (vidsInScope.length) {
      // Supabase limits .in() to ~1000 args, chunk if necessary.
      const CHUNK = 500;
      const PAGE = 1000;
      for (let i = 0; i < vidsInScope.length; i += CHUNK) {
        const slice = vidsInScope.slice(i, i + CHUNK);
        // Paginate to bypass Supabase's default 1000-row limit.
        let from = 0;
        for (;;) {
          const { data, error } = await db
            .from("gmv_max_vid_daily")
            .select(
              "country, advertiser_id, campaign_id, item_group_id, vid, stat_date, cost, gross_revenue, orders, product_impressions, product_clicks, creative_delivery_status",
            )
            .in("vid", slice)
            .gte("stat_date", body.start_date)
            .lte("stat_date", body.end_date)
            .range(from, from + PAGE - 1);
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as DailyRow[];
          daily = daily.concat(rows);
          if (rows.length < PAGE) break;
          from += PAGE;
        }
      }
    }

    // 3) Load sku map
    const productIds = Array.from(new Set(daily.map((d) => d.item_group_id).filter(Boolean)));
    let sku: SkuRow[] = [];
    if (productIds.length) {
      const CHUNK = 500;
      for (let i = 0; i < productIds.length; i += CHUNK) {
        const slice = productIds.slice(i, i + CHUNK);
        const { data, error } = await db
          .from("sku_product_map")
          .select("country, product_id, merchant_sku, product_name")
          .in("product_id", slice);
        if (error) throw new Error(error.message);
        sku = sku.concat((data ?? []) as SkuRow[]);
      }
    }
    // product_id -> first merchant_sku (allow many); we expose first match for table
    const skuByPid = new Map<string, SkuRow>();
    for (const s of sku) if (!skuByPid.has(s.product_id)) skuByPid.set(s.product_id, s);

    // 4) Aggregate per (vid) -> we group by (country, staff, source, vid, item_group_id)
    type AggKey = string;
    type Agg = {
      country: string;
      staff_name: string;
      source_type: string;
      vid: string;
      item_group_id: string;
      registered_sku: string;
      merchant_sku: string;
      product_id: string;
      cost: number;
      gross_revenue: number;
      orders: number;
      product_impressions: number;
      product_clicks: number;
    };
    const aggMap = new Map<AggKey, Agg>();

    // Index daily by vid for quick join
    const dailyByVid = new Map<string, DailyRow[]>();
    for (const d of daily) {
      const arr = dailyByVid.get(d.vid) ?? [];
      arr.push(d);
      dailyByVid.set(d.vid, arr);
    }

    for (const s of staff) {
      const ds = dailyByVid.get(s.vid) ?? [];
      if (ds.length === 0) {
        // include row with zeros so unmatched VIDs still show
        const key = `${s.country}|${s.staff_name}|${s.source_type}|${s.vid}|`;
        if (!aggMap.has(key))
          aggMap.set(key, {
            country: s.country,
            staff_name: s.staff_name,
            source_type: s.source_type,
            vid: s.vid,
            item_group_id: "",
            registered_sku: s.registered_sku ?? "",
            merchant_sku: "",
            product_id: "",
            cost: 0,
            gross_revenue: 0,
            orders: 0,
            product_impressions: 0,
            product_clicks: 0,
          });
      } else {
        for (const d of ds) {
          const skuMeta = skuByPid.get(d.item_group_id);
          const merchant_sku = skuMeta?.merchant_sku ?? "";
          if (body.merchant_skus?.length && !body.merchant_skus.includes(merchant_sku)) continue;
          if (body.product_ids?.length && !body.product_ids.includes(d.item_group_id)) continue;
          const key = `${s.country}|${s.staff_name}|${s.source_type}|${s.vid}|${d.item_group_id}`;
          let agg = aggMap.get(key);
          if (!agg) {
            agg = {
              country: s.country,
              staff_name: s.staff_name,
              source_type: s.source_type,
              vid: s.vid,
              item_group_id: d.item_group_id,
              registered_sku: s.registered_sku ?? "",
              merchant_sku,
              product_id: d.item_group_id,
              cost: 0,
              gross_revenue: 0,
              orders: 0,
              product_impressions: 0,
              product_clicks: 0,
            };
            aggMap.set(key, agg);
          }
          agg.cost += d.cost;
          agg.gross_revenue += d.gross_revenue;
          agg.orders += d.orders;
          agg.product_impressions += d.product_impressions;
          agg.product_clicks += d.product_clicks;
        }
      }
    }

    const rows = Array.from(aggMap.values()).map((a) => ({
      ...a,
      roi: safeDiv(a.gross_revenue, a.cost),
      ctr: safeDiv(a.product_clicks, a.product_impressions),
      cvr: safeDiv(a.orders, a.product_clicks),
    }));

    // 5) Daily series (aggregated)
    const dayMap = new Map<
      string,
      {
        stat_date: string;
        cost: number;
        gross_revenue: number;
        orders: number;
        product_impressions: number;
        product_clicks: number;
      }
    >();
    const staffVidSet = new Set(staff.map((s) => s.vid));
    for (const d of daily) {
      if (!staffVidSet.has(d.vid)) continue;
      const e = dayMap.get(d.stat_date) ?? {
        stat_date: d.stat_date,
        cost: 0,
        gross_revenue: 0,
        orders: 0,
        product_impressions: 0,
        product_clicks: 0,
      };
      e.cost += d.cost;
      e.gross_revenue += d.gross_revenue;
      e.orders += d.orders;
      e.product_impressions += d.product_impressions;
      e.product_clicks += d.product_clicks;
      dayMap.set(d.stat_date, e);
    }
    const series = Array.from(dayMap.values())
      .sort((a, b) => a.stat_date.localeCompare(b.stat_date))
      .map((d) => ({
        ...d,
        roi: safeDiv(d.gross_revenue, d.cost),
        ctr: safeDiv(d.product_clicks, d.product_impressions),
        cvr: safeDiv(d.orders, d.product_clicks),
      }));


    return new Response(JSON.stringify({ rows, series }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("gmv-max-query", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
