// Server Route: read or append to authorize_log table.
// POST body: { action: "list", limit?: number }
//         or { action: "append", source, success, failed, no_account, errors, note? }
// Auth: x-admin-passcode + x-admin-name headers (same as Edge Functions).

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPasscode(req: Request): Promise<boolean> {
  const passcode = (req.headers.get("x-admin-passcode") ?? "").trim();
  if (!passcode) return false;

  // Root env passcode bypass
  const envCode = process.env.ADMIN_PASSCODE;
  if (envCode && passcode === envCode) return true;

  const hash = await sha256Hex(passcode);
  const db = adminClient();
  const rawName = req.headers.get("x-admin-name") ?? "";
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch { /* keep raw */ }

  let q = db
    .from("app_accounts")
    .select("id, active")
    .eq("passcode_hash", hash)
    .eq("active", true);
  if (name) q = q.eq("name", name);
  const { data } = await q.maybeSingle();
  return !!data;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-passcode, x-admin-name",
};

export const Route = createFileRoute("/api/authorize-log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response("ok", { headers: CORS });
        }

        const authed = await verifyPasscode(request);
        if (!authed) {
          return new Response(JSON.stringify({ error: "未授权" }), {
            status: 401,
            headers: { ...CORS, "Content-Type": "application/json" },
          });
        }

        const body = await request.json();
        const db = adminClient();

        if (body.action === "list") {
          const limit = Math.min(body.limit ?? 50, 200);
          const { data, error } = await db
            .from("authorize_log")
            .select("id, logged_at, source, success, failed, no_account, errors, note")
            .order("logged_at", { ascending: false })
            .limit(limit);
          if (error) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { ...CORS, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ logs: data ?? [] }), {
            headers: { ...CORS, "Content-Type": "application/json" },
          });
        }

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
          if (error) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { ...CORS, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...CORS, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ error: "unknown action" }), {
          status: 400,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      },
    },
  },
});
