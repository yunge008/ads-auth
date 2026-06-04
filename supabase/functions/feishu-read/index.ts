// Read pending materials from Feishu spreadsheet.
// Body: { staff: [{name, sheet_name}], accounts: [{country, advertiser_name, advertiser_id}] }
// Columns: A国家 B达人名称 C VID D授权码 E产品 F状态 G错误信息 (row 1 = header)
// Returns rows where status (col F) is empty OR equals 待授权.

import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";

type Account = { country: string; advertiser_name: string; advertiser_id: string };
type StaffIn = { name: string; sheet_name: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
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
      const rows = await readRange(token, spreadsheetToken, `${sheetId}!A2:G`);
      rows.forEach((r, idx) => {
        const [country, creator, vid, authCode, product, status, errMsg] = (r ?? []).map(
          (c) => (c == null ? "" : String(c).trim()),
        );
        // Skip rows that are fully empty or already finalized
        if (!country && !vid && !authCode) return;
        if (status && status !== "待授权") return;
        const acc = accByCountry.get(country);
        materials.push({
          id: crypto.randomUUID(),
          row_number: idx + 2,
          staff_name: s.name,
          sheet_name: s.sheet_name,
          country,
          creator_name: creator,
          vid,
          auth_code: authCode,
          product,
          advertiser_id: acc?.advertiser_id,
          advertiser_name: acc?.advertiser_name,
          status: !authCode
            ? "代码有误"
            : !acc
            ? "无授权账号"
            : "待授权",
          error_message: errMsg || undefined,
        });
      });
    }

    return new Response(
      JSON.stringify({ materials, missing_sheets: missingSheets }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("feishu-read error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
