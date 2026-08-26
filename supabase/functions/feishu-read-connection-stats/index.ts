// Sync BD 建联表 (5 sheets) + 剪辑登记表 (2 sheets) -> connection_material_registry.
// Read-only against Feishu (no writeback); only writes our own Supabase cache table.
// Per source_sheet: delete existing rows then bulk insert fresh ones (avoids stale rows
// when a Feishu row is edited/removed upstream).
//
// BD sheet columns (1-indexed, 建联-xxx layout, same as feishu-read):
//   A=同事 B=发样日期 C=国家 D=达人用户名 F=粉丝数(K) H=30天GMV(USD)
//   K=SKU N=视频登记日期 O=视频发布日期 P=VID Q=授权码
// EDITOR sheet columns (1-indexed, same as feishu-read-editors):
//   B=同事 C=日期(发布日期) D=国家 E=账号 F=SKU G=VID
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { cellText, parseDate } from "../_shared/cells.ts";

const VID_RE = /^7\d{18}$/;
const COUNTRY_RE = /^[\u4e00-\u9fa5A-Za-z0-9\-\s]{1,10}$/;

type Row = {
  source_type: "BD" | "EDITOR";
  source_sheet: string;
  row_number: number;
  staff_name: string;
  staff_active: boolean;
  country: string;
  handle: string;
  sku: string | null;
  fan_count: number | null;
  gmv_usd: number | null;
  sample_date: string | null;
  register_date: string | null;
  post_date: string | null;
  vid: string;
  auth_code: string | null;
};

function toNum(v: unknown): number | null {
  const s = cellText(v);
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "connection-stats");
    const db = admin();

    const { data: staffRows, error: staffErr } = await db
      .from("staff_sheets")
      .select("name, sheet_name, active, role")
      .eq("active", true)
      .in("role", ["BD", "EDITOR"]);
    if (staffErr) throw new Error(staffErr.message);
    const staff = (staffRows ?? []) as { name: string; sheet_name: string; active: boolean; role: "BD" | "EDITOR" }[];
    const bdTargets = staff.filter((s) => s.role === "BD");
    const editorTargets = staff.filter((s) => s.role === "EDITOR");

    const token = await getTenantAccessToken();
    const rows: Row[] = [];
    const missing: string[] = [];
    const touchedSheets = new Set<string>();

    if (bdTargets.length) {
      const mainToken = getSpreadsheetToken();
      const mainSheets = await listSheets(token, mainToken);
      const byName = new Map(mainSheets.map((s) => [s.title, s.sheet_id]));
      for (const t of bdTargets) {
        const sid = byName.get(t.sheet_name);
        if (!sid) { missing.push(t.sheet_name); continue; }
        touchedSheets.add(t.sheet_name);
        const data = await readRange(token, mainToken, `${sid}!A2:Q`, 250);
        for (let i = 0; i < data.length; i++) {
          const r = data[i] ?? [];
          const country = cellText(r[2]);
          const handle = cellText(r[3]);
          if (!COUNTRY_RE.test(country) || !handle) continue;
          const vidRaw = cellText(r[15]);
          const vid = VID_RE.test(vidRaw) ? vidRaw : "";
          rows.push({
            source_type: "BD",
            source_sheet: t.sheet_name,
            row_number: i + 2,
            staff_name: t.name,
            staff_active: !!t.active,
            country,
            handle,
            sku: cellText(r[10]) || null,
            fan_count: toNum(r[5]),
            gmv_usd: toNum(r[7]),
            sample_date: parseDate(r[1]),
            register_date: parseDate(r[13]),
            post_date: parseDate(r[14]),
            vid,
            auth_code: cellText(r[16]) || null,
          });
        }
      }
    }

    if (editorTargets.length) {
      const edToken = getSpreadsheetToken("FEISHU_EDITOR_SPREADSHEET_TOKEN");
      const edSheets = await listSheets(token, edToken);
      const byName = new Map(edSheets.map((s) => [s.title, s.sheet_id]));
      for (const t of editorTargets) {
        const sid = byName.get(t.sheet_name);
        if (!sid) { missing.push(t.sheet_name); continue; }
        touchedSheets.add(t.sheet_name);
        const data = await readRange(token, edToken, `${sid}!A2:G`, 500);
        for (let i = 0; i < data.length; i++) {
          const r = data[i] ?? [];
          const rowStaff = cellText(r[1]);
          if (!rowStaff || rowStaff !== t.name) continue;
          const vidRaw = cellText(r[6]);
          if (!vidRaw || !VID_RE.test(vidRaw)) continue;
          rows.push({
            source_type: "EDITOR",
            source_sheet: t.sheet_name,
            row_number: i + 2,
            staff_name: t.name,
            staff_active: !!t.active,
            country: cellText(r[3]),
            handle: cellText(r[4]),
            sku: cellText(r[5]) || null,
            fan_count: null,
            gmv_usd: null,
            sample_date: null,
            register_date: null,
            post_date: parseDate(r[2]),
            vid: vidRaw,
            auth_code: null,
          });
        }
      }
    }

    let inserted = 0;
    if (touchedSheets.size) {
      const { error: delErr } = await db
        .from("connection_material_registry")
        .delete()
        .in("source_sheet", Array.from(touchedSheets));
      if (delErr) throw new Error(delErr.message);
    }
    if (rows.length) {
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        const { error: insErr } = await db.from("connection_material_registry").insert(batch);
        if (insErr) throw new Error(insErr.message);
        inserted += batch.length;
      }
    }

    return new Response(
      JSON.stringify({ inserted, sheets_synced: touchedSheets.size, missing_sheets: missing }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("feishu-read-connection-stats", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
