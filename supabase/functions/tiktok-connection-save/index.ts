// Persist a TikTok connection AFTER the user picks which advertisers to keep.
// Body: { label, access_token, bc_id, expires_at, advertiser_ids: string[] }
// Returns: { id, label, advertiser_ids }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const body = (await req.json()) as {
      label?: string;
      access_token?: string;
      bc_id?: string | null;
      expires_at?: string | null;
      advertiser_ids?: string[];
    };
    const label = (body.label ?? "未命名").trim();
    const access_token = String(body.access_token ?? "");
    const advertiser_ids = Array.isArray(body.advertiser_ids)
      ? body.advertiser_ids.map((x) => String(x)).filter(Boolean)
      : [];
    if (!access_token) throw new Error("access_token 必填");
    if (!advertiser_ids.length) throw new Error("请至少选择一个广告户");

    const { data, error } = await admin()
      .from("tiktok_connections")
      .insert({
        label,
        access_token,
        bc_id: body.bc_id ?? null,
        advertiser_ids,
        expires_at: body.expires_at ?? null,
      })
      .select("id, label, advertiser_ids")
      .single();
    if (error) throw new Error(error.message);

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("tiktok-connection-save", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
