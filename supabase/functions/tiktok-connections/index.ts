// List/update/delete tiktok_connections and per-advertiser country mappings.
// Ops:
//   { op: "list" } -> { connections: [...], countries: {advertiser_id: country} }
//   { op: "delete", id }                  -> { ok }
//   { op: "update", id, label }           -> { ok }
//   { op: "set_country", advertiser_id, country }  // empty country to clear
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const body = (await req.json().catch(() => ({}))) as {
      op?: string;
      id?: string;
      label?: string;
      advertiser_id?: string;
      country?: string;
    };

    if (body.op === "delete") {
      if (!body.id) throw new Error("id 必填");
      const { error } = await admin().from("tiktok_connections").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "update") {
      if (!body.id) throw new Error("id 必填");
      const label = (body.label ?? "").trim();
      if (!label) throw new Error("label 不能为空");
      const { error } = await admin()
        .from("tiktok_connections")
        .update({ label })
        .eq("id", body.id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "set_country") {
      const aid = (body.advertiser_id ?? "").trim();
      if (!aid) throw new Error("advertiser_id 必填");
      const country = (body.country ?? "").trim();
      if (!country) {
        const { error } = await admin()
          .from("advertiser_countries")
          .delete()
          .eq("advertiser_id", aid);
        if (error) throw new Error(error.message);
      } else {
        // Enforce country uniqueness: one country -> one advertiser
        const { data: occupant, error: qErr } = await admin()
          .from("advertiser_countries")
          .select("advertiser_id")
          .eq("country", country)
          .neq("advertiser_id", aid)
          .maybeSingle();
        if (qErr) throw new Error(qErr.message);
        if (occupant) {
          return new Response(
            JSON.stringify({
              error: `国家「${country}」已被广告户 ${occupant.advertiser_id} 占用，请先清空对方再设置`,
            }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { error } = await admin()
          .from("advertiser_countries")
          .upsert({ advertiser_id: aid, country }, { onConflict: "advertiser_id" });
        if (error) throw new Error(error.message);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // default: list connections + country mapping
    const [{ data: conns, error: e1 }, { data: countries, error: e2 }] = await Promise.all([
      admin()
        .from("tiktok_connections")
        .select("id, label, bc_id, advertiser_ids, expires_at, created_at, updated_at")
        .order("created_at", { ascending: false }),
      admin().from("advertiser_countries").select("advertiser_id, country"),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    const countryMap: Record<string, string> = {};
    for (const r of (countries ?? []) as { advertiser_id: string; country: string }[]) {
      countryMap[r.advertiser_id] = r.country;
    }
    return new Response(
      JSON.stringify({ connections: conns ?? [], countries: countryMap }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
