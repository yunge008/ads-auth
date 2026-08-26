// Read-only diagnostic: calls TikTok GET /gmv_max/identity/get/ to check
// which identities (TikTok accounts, including ones authorized in Business
// Center) are eligible for a GMV Max campaign on a given advertiser_id +
// store. Used from the API测试 page to verify the identity_list fix plan
// (see docs/PLAN.md) before it's wired into the create/batch-create flow —
// this function itself does not create or modify anything.
//
// Body: { advertiser_id: string, store_id?: string, params?: Record<string, string | number> }
// store_id defaults to advertiser_countries.shop_id for the advertiser when omitted.
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { findConnectionsForAdvertiser } from "../_shared/gmv-max-adgroup.ts";
import { ttGet } from "../_shared/tiktok.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "api-test");
    const body = (await req.json().catch(() => ({}))) as {
      advertiser_id?: unknown;
      store_id?: unknown;
      params?: Record<string, unknown>;
    };
    const advertiserId = String(body.advertiser_id ?? "").trim();
    if (!advertiserId) throw new Error("advertiser_id 必填");

    const db = admin();
    let storeId = String(body.store_id ?? "").trim();
    if (!storeId) {
      const { data } = await db
        .from("advertiser_countries")
        .select("shop_id")
        .eq("advertiser_id", advertiserId)
        .maybeSingle();
      storeId = (data?.shop_id as string | null) ?? "";
    }

    const params: Record<string, string> = { advertiser_id: advertiserId };
    if (storeId) params.store_id = storeId;
    for (const [k, v] of Object.entries(body.params ?? {})) {
      if (v != null) params[k] = String(v);
    }

    const conns = await findConnectionsForAdvertiser(db, advertiserId);
    if (!conns.length) throw new Error("该广告户没有可用的 TikTok 授权");
    const data = await ttGet(conns[0].access_token, "/gmv_max/identity/get/", params);
    return new Response(JSON.stringify({ request_params: params, data }), {
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
