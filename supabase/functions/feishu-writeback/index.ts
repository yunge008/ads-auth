// Write status + error message back to Feishu sheet (cols F & G).
// Body: { items: [{sheet_name, row_number, status, error_message?}] }

import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  writeValues,
} from "../_shared/feishu.ts";

type Item = {
  sheet_name: string;
  row_number: number;
  status: string;
  error_message?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { items } = (await req.json()) as { items: Item[] };
    if (!items?.length) throw new Error("items 不能为空");

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken();
    const sheets = await listSheets(token, spreadsheetToken);
    const sheetByName = new Map(sheets.map((s) => [s.title, s.sheet_id]));

    const valueRanges = items
      .map((it) => {
        const sid = sheetByName.get(it.sheet_name);
        if (!sid) return null;
        return {
          range: `${sid}!F${it.row_number}:G${it.row_number}`,
          values: [[it.status, it.error_message ?? ""]],
        };
      })
      .filter((v): v is { range: string; values: unknown[][] } => v != null);

    if (valueRanges.length === 0) throw new Error("没有匹配的 sheet 可回写");

    await writeValues(token, spreadsheetToken, valueRanges);
    return new Response(
      JSON.stringify({ ok: true, updated: valueRanges.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("feishu-writeback error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
