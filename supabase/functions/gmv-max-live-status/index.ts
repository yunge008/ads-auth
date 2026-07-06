// Direct TikTok BC lookup for one GMV Max VID. This does not read or write gmv_max_vid_daily.
// Body: { advertiser_id, campaign_id, item_group_id, vid, start_date?, end_date? }
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttGet } from "../_shared/tiktok.ts";

type ReportRow = {
  dimensions?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
};

function required(value: unknown, name: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} 必填`);
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "api-test");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const advertiserId = required(body.advertiser_id, "advertiser_id");
    const campaignId = required(body.campaign_id, "campaign_id");
    const itemGroupId = required(body.item_group_id, "item_group_id");
    const vid = required(body.vid, "vid");
    const today = new Date().toISOString().slice(0, 10);
    const startDate = String(body.start_date ?? today).trim();
    const endDate = String(body.end_date ?? today).trim();

    const db = admin();
    const [{ data: connections, error: connectionError }, { data: advertiser, error: advertiserError }] =
      await Promise.all([
        db.from("tiktok_connections").select("*").contains("advertiser_ids", [advertiserId]),
        db.from("advertiser_countries").select("shop_id").eq("advertiser_id", advertiserId).maybeSingle(),
      ]);
    if (connectionError) throw new Error(connectionError.message);
    if (advertiserError) throw new Error(advertiserError.message);
    const connection = ((connections ?? []) as ConnRow[])[0];
    if (!connection?.access_token) throw new Error(`广告户 ${advertiserId} 没有可用的 TikTok 授权连接`);
    const shopId = String((advertiser as { shop_id?: string | null } | null)?.shop_id ?? "").trim();
    if (!shopId) throw new Error(`广告户 ${advertiserId} 未配置 shop_id`);

    const matches: ReportRow[] = [];
    let pages = 0;
    for (let page = 1; page <= 100; page++) {
      const data = await ttGet(connection.access_token, "/gmv_max/report/get/", {
        advertiser_id: advertiserId,
        store_ids: JSON.stringify([shopId]),
        dimensions: JSON.stringify(["campaign_id", "item_group_id", "item_id", "stat_time_day"]),
        metrics: JSON.stringify([
          "creative_delivery_status",
          "cost",
          "orders",
          "gross_revenue",
          "product_impressions",
          "product_clicks",
          "currency",
        ]),
        start_date: startDate,
        end_date: endDate,
        page: String(page),
        page_size: "1000",
        filtering: JSON.stringify({
          campaign_ids: [campaignId],
          item_group_ids: [itemGroupId],
        }),
      });
      pages = page;
      const list = (data.list ?? []) as ReportRow[];
      for (const row of list) {
        if (String(row.dimensions?.item_id ?? "") === vid) matches.push(row);
      }
      const pageInfo = (data.page_info ?? {}) as Record<string, unknown>;
      const totalPage = Number(pageInfo.total_page ?? 0);
      const total = Number(pageInfo.total_number ?? 0);
      if (!list.length || (totalPage > 0 && page >= totalPage) || (!totalPage && total > 0 && page * 1000 >= total)) break;
    }

    return new Response(JSON.stringify({
      source: "tiktok_bc_live",
      endpoint: "/open_api/v1.3/gmv_max/report/get/",
      queried_at: new Date().toISOString(),
      advertiser_id: advertiserId,
      shop_id: shopId,
      campaign_id: campaignId,
      item_group_id: itemGroupId,
      vid,
      start_date: startDate,
      end_date: endDate,
      found: matches.length > 0,
      pages_scanned: pages,
      rows: matches,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
