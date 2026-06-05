// Scan BD feishu sheets -> upsert staff_vid_map (source_type='BD').
// Uses staff_sheets where role='BD' AND active=true.
// BD sheet columns (1-indexed): C=国家 G=VID (same as feishu-read).
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

const VID_RE = /^7\d{18}$/;
const COUNTRY_RE = /^[\u4e00-\u9fa5A-Za-z0-9\-\s]{1,10}$/;

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
    const db = admin();
    const { data: sheetsRow, error } = await db
      .from("staff_sheets")
      .select("name, sheet_name, active, role")
      .eq("active", true)
      .eq("role", "BD");
    if (error) throw new Error(error.message);
    const targets = (sheetsRow ?? []).map((d) => ({ name: d.name, sheet_name: d.sheet_name }));
    if (!targets.length) {
      return new Response(JSON.stringify({ upserted: 0, missing_sheets: [] }), {
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
      source_type: "BD";
      source_sheet: string;
      registered_sku: string | null;
    }> = [];
    const missing: string[] = [];

    for (const t of targets) {
      const sid = byName.get(t.sheet_name);
      if (!sid) {
        missing.push(t.sheet_name);
        continue;
      }
      const data = await readRange(token, spreadsheetToken, `${sid}!A2:I`);
      for (const r of data) {
        const row = r ?? [];
        const country = cellText(row[2]);
        // 允许国家为空；只在有内容但格式非法时跳过
        if (country && !COUNTRY_RE.test(country)) continue;
        const vid = cellText(row[6]);
        if (!vid || !VID_RE.test(vid)) continue;

        rows.push({
          country,
          staff_name: t.name,
          vid,
          source_type: "BD",
          source_sheet: t.sheet_name,
          registered_sku: cellText(row[8]) || null,
        });
      }
    }

    // Dedupe by unique key (country, staff_name, vid, source_type) — last wins
    const dedup = new Map<string, (typeof rows)[number]>();
    for (const r of rows) dedup.set(`${r.country}|${r.staff_name}|${r.vid}|${r.source_type}`, r);
    const finalRows = Array.from(dedup.values());

    let upserted = 0;
    if (finalRows.length) {
      const CHUNK = 500;
      for (let i = 0; i < finalRows.length; i += CHUNK) {
        const batch = finalRows.slice(i, i + CHUNK);
        const { error: upErr } = await db
          .from("staff_vid_map")
          .upsert(batch, { onConflict: "country,staff_name,vid,source_type" });
        if (upErr) throw new Error(upErr.message);
        upserted += batch.length;
      }
    }


    return new Response(
      JSON.stringify({ upserted, missing_sheets: missing }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("feishu-read-bd-vids", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
