// Read-only: dump raw TikTok GMV Max campaign settings for one advertiser.
// Used to (1) discover the exact field names of settings the create docs don't
// list (promotion days / auto budget / AI creative / new-creative testing),
// (2) export a source account's ad groups before migrating them to another
// account. Never writes anything.
//
// Body: { advertiser_id, campaign_ids?: string[], offset?: number, limit?: number (<=60),
//         include_store?: boolean }
//   - no campaign_ids → lists all Product GMV Max campaigns, returns info for
//     campaigns[offset .. offset+limit); call again with next_offset until null.
// Returns: { campaigns: [{campaign_id, campaign_name, operation_status}],
//            infos: [{campaign_id, ok, info?, error?}], next_offset, store_list? }
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttGet } from "../_shared/tiktok.ts";
import { fetchCampaigns } from "../_shared/gmv-max-report.ts";

const SOFT_MS = 100_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const startedAt = Date.now();
  try {
    await checkAdminPasscode(req, "gmv-max-create");
    const body = (await req.json().catch(() => ({}))) as {
      advertiser_id?: unknown; campaign_ids?: unknown; offset?: unknown; limit?: unknown; include_store?: unknown;
    };
    const advertiserId = String(body.advertiser_id ?? "").trim();
    if (!/^\d+$/.test(advertiserId)) throw new Error("advertiser_id 必填，且只能是数字");
    const offset = Math.max(0, Math.floor(Number(body.offset ?? 0)) || 0);
    const limit = Math.min(60, Math.max(1, Math.floor(Number(body.limit ?? 30)) || 30));

    const { data, error } = await admin()
      .from("tiktok_connections")
      .select("access_token, advertiser_ids")
      .contains("advertiser_ids", [advertiserId]);
    if (error) throw new Error(error.message);
    const conns = (data ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids">[];
    if (!conns.length) throw new Error(`广告户 ${advertiserId} 没有可用的 TikTok 授权`);

    // Pick the first token that can read this advertiser's campaigns.
    let token = "";
    let campaigns: { id: string; name: string; operation_status: string }[] = [];
    let lastErr: Error | null = null;
    for (const c of conns) {
      try {
        campaigns = await fetchCampaigns(c.access_token, advertiserId);
        token = c.access_token;
        break;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    if (!token) throw lastErr ?? new Error("读取广告组列表失败");

    const explicit = Array.isArray(body.campaign_ids)
      ? body.campaign_ids.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const targetIds = explicit.length ? explicit : campaigns.map((c) => c.id);
    const slice = explicit.length ? targetIds : targetIds.slice(offset, offset + limit);

    const infos: { campaign_id: string; ok: boolean; info?: unknown; error?: string }[] = [];
    let processed = 0;
    for (const id of slice) {
      if (Date.now() - startedAt > SOFT_MS) break;
      try {
        const info = await ttGet(token, "/campaign/gmv_max/info/", { advertiser_id: advertiserId, campaign_id: id });
        infos.push({ campaign_id: id, ok: true, info });
      } catch (e) {
        infos.push({ campaign_id: id, ok: false, error: (e as Error).message });
      }
      processed++;
    }

    let nextOffset: number | null = null;
    if (!explicit.length) {
      const n = offset + processed;
      nextOffset = n < targetIds.length ? n : null;
    }

    let storeList: unknown = undefined;
    if (body.include_store) {
      try {
        storeList = await ttGet(token, "/gmv_max/store/list/", { advertiser_id: advertiserId });
      } catch (e) {
        storeList = { error: (e as Error).message };
      }
    }

    return json({
      campaigns: campaigns.map((c) => ({ campaign_id: c.id, campaign_name: c.name, operation_status: c.operation_status })),
      infos,
      next_offset: nextOffset,
      ...(storeList !== undefined ? { store_list: storeList } : {}),
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
