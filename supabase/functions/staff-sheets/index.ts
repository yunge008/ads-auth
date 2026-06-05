// CRUD for staff_sheets (passcode-gated, service_role).
// GET-style:  { action: "list" } -> { staff: StaffRow[] }
// POST-style: { action: "replace", staff: StaffRow[] } -> { ok: true }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

type StaffRow = {
  id: string;
  name: string;
  sheet_name: string;
  active: boolean;
  role?: "BD" | "EDITOR";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      staff?: StaffRow[];
    };
    const action = body.action ?? "list";
    const db = admin();

    if (action === "list") {
      const { data, error } = await db
        .from("staff_sheets")
        .select("id,name,sheet_name,active,role,sort_order")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      const staff = (data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        sheet_name: r.sheet_name,
        active: r.active,
        role: (r.role ?? "BD") as "BD" | "EDITOR",
      }));
      return new Response(JSON.stringify({ staff }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "replace") {
      const next = Array.isArray(body.staff) ? body.staff : [];
      const { error: delErr } = await db
        .from("staff_sheets")
        .delete()
        .not("id", "is", null);
      if (delErr) throw new Error(delErr.message);
      if (next.length > 0) {
        const payload = next.map((r, i) => ({
          id: r.id,
          name: r.name,
          sheet_name: r.sheet_name,
          active: r.active,
          role: r.role ?? "BD",
          sort_order: i,
        }));
        const { error: insErr } = await db.from("staff_sheets").insert(payload);
        if (insErr) throw new Error(insErr.message);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    throw new Error(`未知 action: ${action}`);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("staff-sheets", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
