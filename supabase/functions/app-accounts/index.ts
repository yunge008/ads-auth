// CRUD for app_accounts (multi-passcode + per-tab permissions).
// op: "me" -> any active account; returns current account info.
// op: "list" | "create" | "update" | "delete" -> admin only.
import { corsHeaders } from "../_shared/feishu.ts";
import {
  admin,
  requireAdmin,
  sha256Hex,
  verifyPasscode,
} from "../_shared/auth.ts";

type AccountInput = {
  id?: string;
  name: string;
  passcode?: string; // raw, only on create/update-with-reset
  is_admin?: boolean;
  tab_permissions?: string[];
  active?: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      op?: string;
      account?: AccountInput;
      id?: string;
    };
    const op = body.op ?? "me";
    const db = admin();

    if (op === "me") {
      const me = await verifyPasscode(req);
      return new Response(JSON.stringify({ account: me }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // All remaining ops require admin.
    await requireAdmin(req);

    if (op === "list") {
      const { data, error } = await db
        .from("app_accounts")
        .select("id,name,is_admin,tab_permissions,active,created_at,updated_at")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ accounts: data ?? [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (op === "create") {
      const a = body.account;
      if (!a?.name || !a.passcode) throw new Error("名称与密码必填");
      const pass = a.passcode.trim();
      const { data, error } = await db
        .from("app_accounts")
        .insert({
          name: a.name,
          passcode: pass,
          passcode_hash: await sha256Hex(pass),
          is_admin: !!a.is_admin,
          tab_permissions: a.tab_permissions ?? [],
          active: a.active ?? true,
        })
        .select("id,name,is_admin,tab_permissions,active")
        .single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ account: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (op === "update") {
      const a = body.account;
      if (!a?.id) throw new Error("缺少 id");
      const patch: Record<string, unknown> = {
        name: a.name,
        is_admin: !!a.is_admin,
        tab_permissions: a.tab_permissions ?? [],
        active: a.active ?? true,
      };
      if (a.passcode && a.passcode.trim()) {
        const pass = a.passcode.trim();
        patch.passcode = pass;
        patch.passcode_hash = await sha256Hex(pass);
      }
      const { data, error } = await db
        .from("app_accounts")
        .update(patch)
        .eq("id", a.id)
        .select("id,name,is_admin,tab_permissions,active")
        .single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ account: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (op === "delete") {
      const id = body.id ?? body.account?.id;
      if (!id) throw new Error("缺少 id");
      const { error } = await db.from("app_accounts").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`未知 op: ${op}`);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("app-accounts", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
