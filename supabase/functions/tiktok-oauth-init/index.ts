// Build a TikTok BC authorize URL.
// Body: { label: string, redirect_uri: string } -> { authorize_url, state }
import { corsHeaders } from "../_shared/feishu.ts";
import { checkAdminPasscode } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const appId = Deno.env.get("TIKTOK_APP_ID");
    if (!appId) throw new Error("TIKTOK_APP_ID 未配置");
    const { label, redirect_uri } = (await req.json()) as { label?: string; redirect_uri?: string };
    if (!label?.trim()) throw new Error("label 必填");
    if (!redirect_uri) throw new Error("redirect_uri 必填");

    // state 里塞 label，回调时还原。加随机串防止 CSRF。
    const nonce = crypto.randomUUID().slice(0, 8);
    const state = `${nonce}|${label.trim()}`;

    const u = new URL("https://business-api.tiktok.com/portal/auth");
    u.searchParams.set("app_id", appId);
    u.searchParams.set("state", state);
    u.searchParams.set("redirect_uri", redirect_uri);

    return new Response(JSON.stringify({ authorize_url: u.toString(), state }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
