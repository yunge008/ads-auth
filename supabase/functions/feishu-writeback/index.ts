// Write authorize result back to Feishu sheet.
// P = 投放日期 (今天日期，仅成功时写入)
// Q = 状态 + 错误信息 (合并)
// Body: { items: [{sheet_name, row_number, status, error_message?}] }

import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  writeValues,
} from "../_shared/feishu.ts";
import { checkAdminPasscode } from "../_shared/auth.ts";

type Item = {
  sheet_name: string;
  row_number: number;
  status: string;
  error_message?: string;
};

function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    checkAdminPasscode(req);
    const { items } = (await req.json()) as { items: Item[] };
    if (!items?.length) throw new Error("items 不能为空");

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken();
    const sheets = await listSheets(token, spreadsheetToken);
    const sheetByName = new Map(sheets.map((s) => [s.title, s.sheet_id]));
    const dateStr = today();

    const valueRanges = items
      .map((it) => {
        const sid = sheetByName.get(it.sheet_name);
        if (!sid) return null;
        const success = it.status === "已授权";
        const pVal = success ? dateStr : "";
        const qVal = it.error_message
          ? `${it.status}：${it.error_message}`
          : it.status;
        return {
          range: `${sid}!P${it.row_number}:Q${it.row_number}`,
          values: [[pVal, qVal]],
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
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("feishu-writeback error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
