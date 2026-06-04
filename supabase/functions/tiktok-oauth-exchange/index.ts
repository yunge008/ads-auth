// Exchange auth_code for an access_token, fetch advertiser names, return them
// to the client WITHOUT writing to DB. The client lets the user pick advertisers,
// then calls `tiktok-connection-save` to persist the row.
// Body: { auth_code, state }
// Returns: { label, access_token, bc_id, expires_at,
//            advertisers: [{ advertiser_id, advertiser_name, status? }] }
import { corsHeaders } from "../_shared/feishu.ts";
import { checkAdminPasscode } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api";

async function enrich(token: string, ids: string[]) {
  const out = new Map<string, { name: string; status?: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const u = new URL(`${TT}/v1.3/advertiser/info/`);
    u.searchParams.set("advertiser_ids", JSON.stringify(batch));
    u.searchParams.set(
      "fields",
      JSON.stringify(["advertiser_id", "name", "status", "company"]),
    );
    const res = await fetch(u.toString(), { headers: { "Access-Token": token } });
    const j = await res.json().catch(() => ({}));
    const list = Array.isArray(j?.data?.list)
      ? j.data.list
      : Array.isArray(j?.data)
        ? j.data
        : [];
    if (j.code === 0) {
      for (const it of list as Array<Record<string, unknown>>) {
        const id = String(it.advertiser_id ?? it.id ?? "");
        if (!id) continue;
        out.set(id, {
          name: String(it.advertiser_name ?? it.name ?? it.company ?? id),
          status: it.status ? String(it.status) : undefined,
        });
      }
    }
  }
  return out;
}

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
    const bc_id = exJson.data?.bc_id ? String(exJson.data.bc_id) : null;
    const expires_at = exJson.data?.access_token_expire_in
      ? new Date(Date.now() + Number(exJson.data.access_token_expire_in) * 1000).toISOString()
      : null;
    if (!access_token) throw new Error("响应缺少 access_token");

    // Enrich with names so the user can choose by readable name.
    const info = await enrich(access_token, advertiser_ids);
    const advertisers = advertiser_ids.map((id: string) => {
      const e = info.get(id);
      return {
        advertiser_id: id,
        advertiser_name: e?.name ?? id,
        status: e?.status,
      };
    });

    return new Response(
      JSON.stringify({ label, access_token, bc_id, expires_at, advertisers }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("tiktok-oauth-exchange", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
