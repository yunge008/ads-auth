// List advertisers authorized to the developer app (via OAuth token).
// Uses: GET /v1.3/oauth2/advertiser/get/  -> advertiser_id list
//       GET /v1.3/advertiser/info/        -> names (batched, 100 ids per call)
// Returns: { advertisers: [{advertiser_id, advertiser_name, status?}] }

import { corsHeaders } from "../_shared/feishu.ts";

const TT_BASE = "https://business-api.tiktok.com/open_api/v1.3";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const token = Deno.env.get("TIKTOK_BC_ACCESS_TOKEN");
    const appId = Deno.env.get("TIKTOK_APP_ID");
    const appSecret = Deno.env.get("TIKTOK_APP_SECRET");
    if (!token) throw new Error("TIKTOK_BC_ACCESS_TOKEN 未配置");
    if (!appId || !appSecret) throw new Error("TIKTOK_APP_ID / TIKTOK_APP_SECRET 未配置");

    // 1) advertiser ID list bound to this token
    const listUrl = new URL(`${TT_BASE}/oauth2/advertiser/get/`);
    listUrl.searchParams.set("app_id", appId);
    listUrl.searchParams.set("secret", appSecret);
    const listRes = await fetch(listUrl.toString(), {
      headers: { "Access-Token": token },
    });
    const listJson = await listRes.json().catch(() => ({}));
    if (listJson.code !== 0) {
      throw new Error(`TikTok oauth2/advertiser/get 错误: ${listJson.message ?? `HTTP ${listRes.status}`}`);
    }
    const rawList = (listJson.data?.list ?? []) as Array<Record<string, unknown>>;
    const idToName = new Map<string, string>();
    for (const it of rawList) {
      const id = String(it.advertiser_id ?? "");
      if (!id) continue;
      idToName.set(id, String(it.advertiser_name ?? id));
    }
    const ids = Array.from(idToName.keys());

    // 2) enrich with /advertiser/info/ (max 100 ids per call) for accurate names + status
    const enriched = new Map<string, { name: string; status?: string }>();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const infoUrl = new URL(`${TT_BASE}/advertiser/info/`);
      infoUrl.searchParams.set("advertiser_ids", JSON.stringify(batch));
      infoUrl.searchParams.set("fields", JSON.stringify(["id", "name", "status"]));
      const infoRes = await fetch(infoUrl.toString(), {
        headers: { "Access-Token": token },
      });
      const infoJson = await infoRes.json().catch(() => ({}));
      if (infoJson.code === 0 && Array.isArray(infoJson.data)) {
        for (const it of infoJson.data as Array<Record<string, unknown>>) {
          const id = String(it.id ?? it.advertiser_id ?? "");
          if (!id) continue;
          enriched.set(id, {
            name: String(it.name ?? idToName.get(id) ?? id),
            status: it.status ? String(it.status) : undefined,
          });
        }
      }
    }

    const advertisers = ids.map((id) => {
      const e = enriched.get(id);
      return {
        advertiser_id: id,
        advertiser_name: e?.name ?? idToName.get(id) ?? id,
        status: e?.status,
      };
    });

    return new Response(JSON.stringify({ advertisers }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bc-list-advertisers error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
