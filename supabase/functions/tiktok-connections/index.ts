// List or delete tiktok_connections rows.
// Body: { op: "list" } -> { connections: [...without access_token...] }
//       { op: "delete", id } -> { ok: true }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    checkAdminPasscode(req);
    const body = (await req.json().catch(() => ({}))) as { op?: string; id?: string; label?: string };

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


    // default: list
    const { data, error } = await admin()
      .from("tiktok_connections")
      .select("id, label, bc_id, advertiser_ids, expires_at, created_at, updated_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return new Response(JSON.stringify({ connections: data ?? [] }), {
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
