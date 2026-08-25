// Structured GMV Max campaign ("ad group") batch creation — used by the
// GMV Max 新建 page (single form submits a 1-row batch; Excel upload submits
// many). Unlike gmv-max-adgroup-create (raw TikTok body passthrough for
// api-test), this fills in store_id / store_authorized_bc_id from our own
// tables and applies fixed defaults for the fields the user doesn't choose:
// shopping_ads_type=PRODUCT, product_specific_type=CUSTOMIZED_PRODUCTS,
// optimization_goal=VALUE, deep_bid_type=VO_MIN_ROAS,
// product_video_specific_type=AUTO_SELECTION.
//
// This is a live write call — every row creates a real, spend-generating
// TikTok GMV Max campaign.
//
// Body: { rows: [{ advertiser_id, campaign_name, item_group_ids: string[],
//                   roas_bid: number, budget: number,
//                   start_time?: "YYYY-MM-DD HH:MM:SS",
//                   end_time?: "YYYY-MM-DD HH:MM:SS" }] }
// Returns: { results: [{ row, advertiser_id, campaign_name, ok, campaign_id?, error? }] }
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { createGmvMaxCampaign, genRequestId } from "../_shared/gmv-max-adgroup.ts";

type RowInput = {
  advertiser_id?: unknown;
  campaign_name?: unknown;
  item_group_ids?: unknown;
  roas_bid?: unknown;
  budget?: unknown;
  start_time?: unknown;
  end_time?: unknown;
};

type Result = {
  row: number;
  advertiser_id: string;
  campaign_name: string;
  ok: boolean;
  campaign_id?: string;
  error?: string;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}
// Default start = now + 5 minutes, naive wall-clock string (no timezone
// conversion) — matches the format TikTok accepted in manual testing.
function defaultStartTime(): string {
  const d = new Date(Date.now() + 5 * 60000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "gmv-max-create");
    const body = (await req.json().catch(() => ({}))) as { rows?: RowInput[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new Error("rows 必填且不能为空");
    if (rows.length > 200) throw new Error("单次最多 200 行");

    const advertiserIds = Array.from(
      new Set(rows.map((r) => String(r.advertiser_id ?? "").trim()).filter(Boolean)),
    );
    if (!advertiserIds.length) throw new Error("每行都需要 advertiser_id");

    const db = admin();
    const [{ data: shopRows, error: shopErr }, { data: connRows, error: connErr }] = await Promise.all([
      db.from("advertiser_countries").select("advertiser_id, shop_id").in("advertiser_id", advertiserIds),
      db.from("tiktok_connections").select("access_token, advertiser_ids, bc_id"),
    ]);
    if (shopErr) throw new Error(shopErr.message);
    if (connErr) throw new Error(connErr.message);

    const shopByAdv = new Map((shopRows ?? []).map((r) => [r.advertiser_id as string, r.shop_id as string | null]));
    const allConns = (connRows ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids" | "bc_id">[];
    const connsForAdv = (advertiserId: string) => allConns.filter((c) => c.advertiser_ids.includes(advertiserId));

    const results: Result[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const advertiserId = String(r.advertiser_id ?? "").trim();
      const campaignName = String(r.campaign_name ?? "").trim();
      const itemGroupIds = (Array.isArray(r.item_group_ids) ? r.item_group_ids : [])
        .map((x) => String(x).trim())
        .filter(Boolean);
      const roasBid = Number(r.roas_bid);
      const budget = Number(r.budget);
      const startTime = String(r.start_time ?? "").trim() || defaultStartTime();
      const endTime = String(r.end_time ?? "").trim();

      const fail = (error: string) => results.push({ row: i + 1, advertiser_id: advertiserId, campaign_name: campaignName, ok: false, error });

      if (!advertiserId) { fail("advertiser_id 必填"); continue; }
      if (!campaignName) { fail("campaign_name 必填"); continue; }
      if (!itemGroupIds.length) { fail("商品ID 至少一个"); continue; }
      if (!Number.isFinite(roasBid) || roasBid <= 0) { fail("ROI 必须是大于 0 的数字"); continue; }
      if (!Number.isFinite(budget) || budget <= 0) { fail("预算必须是大于 0 的数字"); continue; }

      const shopId = shopByAdv.get(advertiserId);
      if (!shopId) { fail(`广告户 ${advertiserId} 未配置店铺 ID（设置页 → 店铺ID）`); continue; }
      const conns = connsForAdv(advertiserId);
      if (!conns.length) { fail(`广告户 ${advertiserId} 没有可用的 TikTok 授权`); continue; }
      const bcId = conns.find((c) => c.bc_id)?.bc_id;
      if (!bcId) { fail(`广告户 ${advertiserId} 找不到 BC ID（设置页授权连接需含该广告户）`); continue; }

      const ttBody: Record<string, unknown> = {
        request_id: genRequestId(i),
        advertiser_id: advertiserId,
        campaign_name: campaignName,
        store_id: shopId,
        store_authorized_bc_id: bcId,
        shopping_ads_type: "PRODUCT",
        product_specific_type: "CUSTOMIZED_PRODUCTS",
        item_group_ids: itemGroupIds,
        optimization_goal: "VALUE",
        deep_bid_type: "VO_MIN_ROAS",
        roas_bid: roasBid,
        budget,
        schedule_type: endTime ? "SCHEDULE_START_END" : "SCHEDULE_FROM_NOW",
        schedule_start_time: startTime,
        product_video_specific_type: "AUTO_SELECTION",
      };
      if (endTime) ttBody.schedule_end_time = endTime;

      try {
        const data = await createGmvMaxCampaign(conns, ttBody);
        results.push({
          row: i + 1,
          advertiser_id: advertiserId,
          campaign_name: campaignName,
          ok: true,
          campaign_id: data.campaign_id ? String(data.campaign_id) : undefined,
        });
      } catch (e) {
        fail((e as Error).message);
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
