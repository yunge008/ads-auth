// Read pending materials from Feishu spreadsheet (strict validation).
// Body: { staff: [{name, sheet_name}], accounts: [{country, advertiser_name, advertiser_id}] }
// Column mapping (1-indexed):
//   A=序号  B=登记日期  C=国家  D=达人名称  E-F=其他  G=VID  H=授权码
//   I=产品  ...  P=投放日期(状态/回写日期)  Q=回写状态+错误
// Filtering rules (all must pass):
//   - B is a recognizable date (string parseable OR Excel serial number)
//   - C is country: length<=10, only Chinese/English letters/space
//   - G matches /^7\d{18}$/
//   - H matches /^#[A-Za-z0-9+/]{63}=$/
//   - P is empty AND there exists an earlier row in same sheet with non-empty P

import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

type StaffIn = { name: string; sheet_name: string };



const VID_RE = /^7\d{18}$/;
const CODE_RE = /^#[A-Za-z0-9+/]{63}=$/;
const COUNTRY_RE = /^[\u4e00-\u9fa5A-Za-z0-9\-\s]{1,10}$/;

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  // Feishu rich-text: array of segments { text }
  if (Array.isArray(v)) {
    return v
      .map((s) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text ?? "") : String(s ?? "")))
      .join("")
      .trim();
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return (o.text as string).trim();
  }
  return String(v).trim();
}

function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  // Excel serial number (Feishu returns numbers for date cells)
  if (typeof v === "number" && isFinite(v) && v > 1 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = cellText(v);
  if (!s) return null;
  // Numeric string serial
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1 && n < 100000) {
      const ms = Math.round((n - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  // Common date strings
  const norm = s.replace(/[./]/g, "-");
  const d = new Date(norm);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "home");
    const { staff, include_done } = (await req.json()) as {
      staff: StaffIn[];
      include_done?: boolean;
    };
    if (!staff?.length) throw new Error("staff 不能为空");

    // Load advertiser→country map + advertiser names from DB
    const [{ data: acRows, error: acErr }, { data: connRows, error: connErr }] = await Promise.all([
      admin().from("advertiser_countries").select("advertiser_id, country"),
      admin().from("tiktok_connections").select("advertiser_ids"),
    ]);
    if (acErr) throw new Error(acErr.message);
    if (connErr) throw new Error(connErr.message);
    const knownAdv = new Set<string>();
    for (const r of (connRows ?? []) as { advertiser_ids: string[] }[]) {
      for (const id of r.advertiser_ids) knownAdv.add(id);
    }
    // country -> [{advertiser_id}]
    const accByCountry = new Map<string, { advertiser_id: string }[]>();
    for (const r of (acRows ?? []) as { advertiser_id: string; country: string }[]) {
      if (!knownAdv.has(r.advertiser_id)) continue;
      const key = r.country.trim();
      const arr = accByCountry.get(key) ?? [];
      arr.push({ advertiser_id: r.advertiser_id });
      accByCountry.set(key, arr);
    }

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken();
    const sheets = await listSheets(token, spreadsheetToken);
    const sheetByName = new Map(sheets.map((s) => [s.title, s.sheet_id]));

    const materials: unknown[] = [];
    const missingSheets: string[] = [];

    for (const s of staff) {
      const sheetId = sheetByName.get(s.sheet_name);
      if (!sheetId) {
        missingSheets.push(s.sheet_name);
        continue;
      }
      const rows = await readRange(token, spreadsheetToken, `${sheetId}!A2:Q`);

      let firstPRowIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (cellText((rows[i] ?? [])[15])) {
          firstPRowIdx = i;
          break;
        }
      }
      if (!include_done && firstPRowIdx < 0) continue;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        if (!include_done && i <= firstPRowIdx) continue;
        const dateRaw = cellText(r[1]);
        const dateStr = dateRaw ? parseDate(r[1]) : "";
        if (dateRaw && dateStr === null) continue;
        const country = cellText(r[2]);
        if (!COUNTRY_RE.test(country)) continue;
        const creator = cellText(r[3]);
        const vid = cellText(r[6]);
        if (vid && !VID_RE.test(vid)) continue;
        const authCode = cellText(r[7]);
        if (!CODE_RE.test(authCode)) continue;
        const product = cellText(r[8]);
        const pCell = cellText(r[15]);
        if (!include_done && pCell) continue;

        const matched = accByCountry.get(country) ?? [];
        const base = {
          row_number: i + 2,
          staff_name: s.name,
          sheet_name: s.sheet_name,
          register_date: dateStr ?? "",
          country,
          creator_name: creator,
          vid,
          auth_code: authCode,
          product,
          error_message: undefined,
        };
        if (matched.length === 0) {
          materials.push({
            ...base,
            id: crypto.randomUUID(),
            advertiser_id: undefined,
            advertiser_name: undefined,
            status: "无授权账号",
          });
        } else {
          // One material → one advertiser (first match wins)
          const acc = matched[0];
          materials.push({
            ...base,
            id: crypto.randomUUID(),
            advertiser_id: acc.advertiser_id,
            advertiser_name: acc.advertiser_id,
            status: "待授权",
          });
        }
      }
    }


    return new Response(
      JSON.stringify({ materials, missing_sheets: missingSheets }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("feishu-read error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
