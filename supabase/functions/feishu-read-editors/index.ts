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
import { loadSheetConfig, makeOptionalResolver, staffSheetName } from "../_shared/sheetConfig.ts";

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
    const spreadsheetToken = getSpreadsheetToken("FEISHU_EDITOR_SPREADSHEET_TOKEN");
    // sheet 名解析统一走 _shared/sheetConfig：只归一空白后精确比较，不做别名猜测。
    // 人员表 sheet名 留空的同事，用「设置 → 飞书表名称」里的模板按姓名生成。
    const resolve = makeOptionalResolver(await listSheets(token, spreadsheetToken));
    const sheetCfg = await loadSheetConfig(db);
    const unnamedStaff: string[] = [];
    const sheetOf = (t: { name: string; sheet_name: string }) => {
      const r = staffSheetName(sheetCfg, "EDITOR", t.name, t.sheet_name);
      if (!r.name) unnamedStaff.push(t.name || "(无姓名)");
      return r.name;
    };

    const rows: Array<{
      country: string;
      staff_name: string;
      vid: string;
      source_type: "EDITOR";
      source_sheet: string;
      registered_sku: string | null;
    }> = [];
    const missing: string[] = [];

    for (const t of targets) {
      const sheetName = sheetOf(t);
      if (!sheetName) continue;
      const sid = resolve(sheetName);
      if (!sid) {
        missing.push(sheetName);
        continue;
      }
      const data = await readRange(token, spreadsheetToken, `${sid}!A2:H`);
      for (const r of data) {
        const row = r ?? [];
        const staff = cellText(row[1]);
        // Only rows where B 列同事 = 表对应同事姓名
        if (!staff || staff !== t.name) continue;
        const vid = cellText(row[6]);
        if (!vid || !VID_RE.test(vid)) continue;
        const country = cellText(row[3]);
        rows.push({
          country,
          staff_name: staff,
          vid,
          source_type: "EDITOR",
          source_sheet: sheetName,
          registered_sku: cellText(row[5]) || null,
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
        const { error } = await db
          .from("staff_vid_map")
          .upsert(batch, { onConflict: "country,staff_name,vid,source_type" });
        if (error) throw new Error(error.message);
        upserted += batch.length;
      }
    }


    return new Response(
      JSON.stringify({ upserted, missing_sheets: missing, unnamed_staff: unnamedStaff }),
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
