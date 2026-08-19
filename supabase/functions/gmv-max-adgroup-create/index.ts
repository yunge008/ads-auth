// Create a real GMV Max campaign on TikTok (POST /campaign/gmv_max/create/).
// GMV Max has no separate campaign/adgroup/ad hierarchy — this single call
// bundles what other campaign types split into campaign + ad group (budget,
// bidding, product selection, schedule all live here). This is the closest
// equivalent to "新建 GMV Max 广告组" TikTok's API exposes.
//
// Thin passthrough only: no field validation or defaults. Caller supplies the
// full TikTok GmvMaxCreateBody JSON (advertiser_id, campaign_name, store_id,
// store_authorized_bc_id, optimization_goal, deep_bid_type, shopping_ads_type,
// schedule_type, schedule_start_time, request_id, budget, item_list /
// item_group_ids, identity_list, ... per TikTok's GMV Max Campaign Create doc).
// This creates a live, spend-generating campaign on the real ad account.
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttPost } from "../_shared/tiktok.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "api-test");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const advertiserId = String(body.advertiser_id ?? "").trim();
    if (!advertiserId) throw new Error("advertiser_id 必填（须与 TikTok GmvMaxCreateBody 中的 advertiser_id 一致）");

    const db = admin();
    const { data: connections, error } = await db
      .from("tiktok_connections")
      .select("access_token, advertiser_ids")
      .contains("advertiser_ids", [advertiserId]);
    if (error) throw new Error(error.message);
    const conn = ((connections ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids">[])[0];
    if (!conn) throw new Error(`广告户 ${advertiserId} 没有可用的 TikTok 授权`);

    const data = await ttPost(conn.access_token, "/campaign/gmv_max/create/", body);
    return new Response(JSON.stringify({
      source: "tiktok_bc_live",
      endpoint: "/open_api/v1.3/campaign/gmv_max/create/",
      created_at: new Date().toISOString(),
      data,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
