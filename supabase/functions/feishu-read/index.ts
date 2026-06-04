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
    checkAdminPasscode(req);
    const { staff, accounts } = (await req.json()) as {
      staff: StaffIn[];
      accounts: Account[];
    };
    if (!staff?.length) throw new Error("staff 不能为空");

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken();
    const sheets = await listSheets(token, spreadsheetToken);
    const sheetByName = new Map(sheets.map((s) => [s.title, s.sheet_id]));
    const accByCountry = new Map(accounts.map((a) => [a.country.trim(), a]));

    const materials: unknown[] = [];
    const missingSheets: string[] = [];

    for (const s of staff) {
      const sheetId = sheetByName.get(s.sheet_name);
      if (!sheetId) {
        missingSheets.push(s.sheet_name);
        continue;
      }
      // Read A2:Q (rows from 2 onward, cols A..Q = 17 columns)
      const rows = await readRange(token, spreadsheetToken, `${sheetId}!A2:Q`);

      // Pre-scan: find first row with non-empty P (col index 15)
      let firstPRowIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        if (cellText(r[15])) {
          firstPRowIdx = i;
          break;
        }
      }
      // No "投放日期" anchor yet → no pending rows by spec
      if (firstPRowIdx < 0) continue;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        if (i <= firstPRowIdx) continue; // must be below an anchor row
        // B (登记日期), G (VID), I (产品) are allowed to be empty.
        const dateRaw = cellText(r[1]);
        const dateStr = dateRaw ? parseDate(r[1]) : "";
        if (dateRaw && dateStr === null) continue; // invalid date value
        const country = cellText(r[2]);
        if (!COUNTRY_RE.test(country)) continue;
        const creator = cellText(r[3]);
        const vid = cellText(r[6]);
        if (vid && !VID_RE.test(vid)) continue; // if present, must match
        const authCode = cellText(r[7]);
        if (!CODE_RE.test(authCode)) continue; // auth code remains required
        const product = cellText(r[8]);
        const pCell = cellText(r[15]);
        if (pCell) continue; // already has 投放日期 → already done

        const acc = accByCountry.get(country);
        materials.push({
          id: crypto.randomUUID(),
          row_number: i + 2,
          staff_name: s.name,
          sheet_name: s.sheet_name,
          register_date: dateStr ?? "",
          country,
          creator_name: creator,
          vid,
          auth_code: authCode,
          product,
          advertiser_id: acc?.advertiser_id,
          advertiser_name: acc?.advertiser_name,
          status: !acc ? "无授权账号" : "待授权",
          error_message: undefined,
        });
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
