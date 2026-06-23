// authorize-log: read or append to the authorize_log table.
// Body: { action: "list", limit?: number }
//    or { action: "append", source: "manual"|"cron", success, failed, no_account, errors, note? }
// Auth: passcode header OR x-cron-key bypass.

import { admin, verifyPasscode } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-passcode, x-admin-name, x-cron-key",
};

async function verifyCronKey(req: Request): Promise<boolean> {
  const provided = req.headers.get("x-cron-key");
  if (!provided) return false;
  const db = admin();
  const { data } = await db.rpc("verify_gmv_cron_key", { provided_key: provided });
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const isCron = await verifyCronKey(req);
    if (!isCron) {
      await verifyPasscode(req);
    }

    const body = await req.json();
    const db = admin();

    if (body.action === "append") {
      const { source = "manual", success = 0, failed = 0, no_account = 0, errors = [], note } = body;
      const { error } = await db.from("authorize_log").insert({
        source,
        success,
        failed,
        no_account,
        errors,
        note: note ?? null,
      });
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.action === "list") {
      const limit = Math.min(body.limit ?? 50, 200);
      const { data, error } = await db
        .from("authorize_log")
        .select("id, logged_at, source, success, failed, no_account, errors, note")
        .order("logged_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ logs: data ?? [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status ?? 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
