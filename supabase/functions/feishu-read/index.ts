// Read pending materials from Feishu spreadsheet (strict validation).
// Body: { staff: [{name, sheet_name}], include_done?: boolean }
// Fixed column mapping for 建联-xxx sheets (1-indexed):
//   A=负责同事  B=开发日期  C=地区/店铺(国家)  D=用户名(达人)  E=昵称  F=粉丝数
//   G=联系方式  H=联系渠道  I=佣金公开-广告  J=SKU(样品寄送)  K=寄送数量
//   L=是否合作  M=不合作原因  N=是否开通自动授权  O=视频履约  P=视频发布时间
//   Q=VID  R=授权码(VID CODE, # + 63 chars + =)  S=视频URL  T=备注  U=其他同事已建联
//   V=投放日期(回写)  W=回写状态+错误(回写)
// Filtering rules (all must pass):
//   - B is a recognizable date (string parseable OR Excel serial number) when present
//   - C is country: 1-10 chars, Chinese/English letters/digits/dash/space
//   - R matches the auth code format, AND Q (VID) is non-empty
//   - When include_done=false: V is empty

import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

type StaffIn = { name: string; sheet_name: string };



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
    // Cron bypass: authorize-cron passes x-cron-key with the vault secret value.
    const cronKey = req.headers.get("x-cron-key") ?? "";
    let cronAuthed = false;
    if (cronKey) {
      const { data: ok } = await admin().rpc("verify_gmv_cron_key", { _key: cronKey });
      if (ok === true) cronAuthed = true;
    }
    if (!cronAuthed) await checkAdminPasscode(req, "home");
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
      const rows = await readRange(token, spreadsheetToken, `${sheetId}!A2:W`);

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const dateRaw = cellText(r[1]);
        const dateStr = dateRaw ? parseDate(r[1]) : "";
        if (dateRaw && dateStr === null) continue;
        const country = cellText(r[2]);
        if (!COUNTRY_RE.test(country)) continue;
        const creator = cellText(r[3]);
        const vid = cellText(r[16]);
        const authCode = cellText(r[17]);
        if (!CODE_RE.test(authCode)) continue;
        if (!vid) continue;
        const product = cellText(r[9]);
        const doneCell = cellText(r[21]);
        if (!include_done && doneCell) continue;

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
