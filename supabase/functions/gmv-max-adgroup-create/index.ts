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
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { createGmvMaxCampaign, findConnectionsForAdvertiser } from "../_shared/gmv-max-adgroup.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "api-test");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const advertiserId = String(body.advertiser_id ?? "").trim();
    if (!advertiserId) throw new Error("advertiser_id 必填（须与 TikTok GmvMaxCreateBody 中的 advertiser_id 一致）");

    const db = admin();
    const conns = await findConnectionsForAdvertiser(db, advertiserId);
    const data = await createGmvMaxCampaign(conns, body);
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
