// Exchange auth_code for an access_token and persist a tiktok_connections row.
// Body: { auth_code, state } -> { id, label, advertiser_ids }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    checkAdminPasscode(req);
    const appId = Deno.env.get("TIKTOK_APP_ID");
    const appSecret = Deno.env.get("TIKTOK_APP_SECRET");
    if (!appId || !appSecret) throw new Error("TIKTOK_APP_ID / TIKTOK_APP_SECRET 未配置");

    const { auth_code, state } = (await req.json()) as { auth_code?: string; state?: string };
    if (!auth_code) throw new Error("auth_code 必填");
    const label = (state?.split("|")[1] ?? "未命名").trim();

    // Exchange (v1.3 OAuth)
    const exRes = await fetch(`${TT}/v1.3/oauth2/access_token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code }),
    });
    const exJson = await exRes.json().catch(() => ({}));
    if (exJson.code !== 0) {
      throw new Error(`oauth2/access_token 失败: ${exJson.message ?? `HTTP ${exRes.status}`}`);
    }
    const access_token = String(exJson.data?.access_token ?? "");
    const advertiser_ids = (exJson.data?.advertiser_ids ?? []).map((x: unknown) => String(x));
    const bc_id_field = exJson.data?.bc_id ? String(exJson.data.bc_id) : null;
    const expires_at = exJson.data?.access_token_expire_in
      ? new Date(Date.now() + Number(exJson.data.access_token_expire_in) * 1000).toISOString()
      : null;
    if (!access_token) throw new Error("响应缺少 access_token");

    const { data, error } = await admin()
      .from("tiktok_connections")
      .insert({
        label,
        access_token,
        bc_id: bc_id_field,
        advertiser_ids,
        expires_at,
      })
      .select("id, label, advertiser_ids")
      .single();
    if (error) throw new Error(error.message);

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("tiktok-oauth-exchange", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
