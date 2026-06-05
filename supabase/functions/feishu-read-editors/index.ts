// Read editor feishu sheets -> upsert staff_vid_map (source_type='EDITOR').
// Body: { sheets?: {name, sheet_name}[] }  default: all active staff_sheets with role='EDITOR'.
// Editor sheet columns (1-indexed):
//   B=同事 C=日期 D=国家 E=账号 F=SKU G=VID H=备注
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

const VID_RE = /^7\d{18}$/;

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v))
    return v
      .map((s) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text ?? "") : String(s ?? "")))
      .join("")
      .trim();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return (o.text as string).trim();
  }
  return String(v).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "material-performance");
    const { sheets: bodySheets } = (await req.json().catch(() => ({}))) as {
      sheets?: { name: string; sheet_name: string }[];
    };
    const db = admin();
    let targets = bodySheets;
    if (!targets || !targets.length) {
      const { data, error } = await db
        .from("staff_sheets")
        .select("name, sheet_name, active, role")
        .eq("active", true)
        .eq("role", "EDITOR");
      if (error) throw new Error(error.message);
      targets = (data ?? []).map((d) => ({ name: d.name, sheet_name: d.sheet_name }));
    }
    if (!targets.length) {
      return new Response(JSON.stringify({ upserted: 0, missing_sheets: [], note: "无启用的剪辑同事" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken();
    const all = await listSheets(token, spreadsheetToken);
    const byName = new Map(all.map((s) => [s.title, s.sheet_id]));

    const rows: Array<{
      country: string;
      staff_name: string;
      vid: string;
      source_type: "EDITOR";
      source_sheet: string;
    }> = [];
    const missing: string[] = [];

    for (const t of targets) {
      const sid = byName.get(t.sheet_name);
      if (!sid) {
        missing.push(t.sheet_name);
        continue;
      }
      const data = await readRange(token, spreadsheetToken, `${sid}!A2:H`);
      for (const r of data) {
        const row = r ?? [];
        const staff = cellText(row[1]) || t.name;
        const country = cellText(row[3]);
        const vid = cellText(row[6]);
        if (!vid || !VID_RE.test(vid)) continue;
        rows.push({
          country,
          staff_name: staff,
          vid,
          source_type: "EDITOR",
          source_sheet: t.sheet_name,
        });
      }
    }

    let upserted = 0;
    if (rows.length) {
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        const { error } = await db
          .from("staff_vid_map")
          .upsert(batch, { onConflict: "country,staff_name,vid,source_type" });
        if (error) throw new Error(error.message);
        upserted += batch.length;
      }
    }

    return new Response(
      JSON.stringify({ upserted, missing_sheets: missing }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("feishu-read-editors", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
