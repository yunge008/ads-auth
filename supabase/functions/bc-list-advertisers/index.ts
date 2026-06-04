// Aggregate advertisers across ALL stored TikTok connections.
// Returns: { advertisers: [{advertiser_id, advertiser_name, status?, label}] }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api/v1.3";

async function enrich(token: string, ids: string[]) {
  const out = new Map<string, { name: string; status?: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const u = new URL(`${TT}/advertiser/info/`);
    u.searchParams.set("advertiser_ids", JSON.stringify(batch));
    u.searchParams.set(
      "fields",
      JSON.stringify(["advertiser_id", "name", "status", "company"]),
    );
    const res = await fetch(u.toString(), { headers: { "Access-Token": token } });
    const j = await res.json().catch(() => ({}));
    console.log("advertiser/info response", JSON.stringify(j).slice(0, 800));
    const list = Array.isArray(j?.data?.list)
      ? j.data.list
      : Array.isArray(j?.data)
        ? j.data
        : [];
    if (j.code === 0) {
      for (const it of list as Array<Record<string, unknown>>) {
        const id = String(it.advertiser_id ?? it.id ?? "");
        if (!id) continue;
        const name = String(
          it.advertiser_name ?? it.name ?? it.company ?? id,
        );
        out.set(id, {
          name,
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
    const { data: conns, error } = await admin()
      .from("tiktok_connections")
      .select("*");
    if (error) throw new Error(error.message);
    const rows = (conns ?? []) as ConnRow[];
    if (!rows.length) {
      return new Response(JSON.stringify({ advertisers: [], warning: "尚无 TikTok 连接，请先在设置页点「连接 TikTok」" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const seen = new Map<string, { advertiser_id: string; advertiser_name: string; status?: string; label: string }>();
    const errors: string[] = [];
    for (const c of rows) {
      try {
        const info = await enrich(c.access_token, c.advertiser_ids);
        for (const id of c.advertiser_ids) {
          if (seen.has(id)) continue;
          const e = info.get(id);
          seen.set(id, {
            advertiser_id: id,
            advertiser_name: e?.name ?? id,
            status: e?.status,
            label: c.label,
          });
        }
      } catch (e) {
        errors.push(`[${c.label}] ${(e as Error).message}`);
      }
    }

    return new Response(
      JSON.stringify({ advertisers: Array.from(seen.values()), errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("bc-list-advertisers", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
