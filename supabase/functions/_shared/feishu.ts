// Shared Feishu helpers for edge functions.

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

export async function getTenantAccessToken(): Promise<string> {
  const appId = Deno.env.get("FEISHU_APP_ID");
  const appSecret = Deno.env.get("FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置");
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`飞书鉴权失败: ${json.msg ?? JSON.stringify(json)}`);
  return json.tenant_access_token as string;
}

export function getSpreadsheetToken(): string {
  const raw = Deno.env.get("FEISHU_SPREADSHEET_TOKEN") ?? "";
  // Accept either raw token or full URL like https://xxx.feishu.cn/sheets/<token>?sheet=...
  const m = raw.match(/\/sheets\/([A-Za-z0-9]+)/);
  return (m?.[1] ?? raw).trim();
}

export async function listSheets(token: string, spreadsheetToken: string) {
  const res = await fetch(
    `${FEISHU_BASE}/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (json.code !== 0) throw new Error(`查询 sheet 列表失败: ${json.msg}`);
  return json.data?.sheets as Array<{ sheet_id: string; title: string }>;
}

export async function readRange(
  token: string,
  spreadsheetToken: string,
  range: string, // e.g. "<sheet_id>!A2:G"
) {
  const res = await fetch(
    `${FEISHU_BASE}/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (json.code !== 0) throw new Error(`读取 ${range} 失败: ${json.msg}`);
  return (json.data?.valueRange?.values as unknown[][]) ?? [];
}

export async function writeValues(
  token: string,
  spreadsheetToken: string,
  valueRanges: Array<{ range: string; values: unknown[][] }>,
) {
  const res = await fetch(
    `${FEISHU_BASE}/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_update`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ valueRanges }),
    },
  );
  const json = await res.json();
  if (json.code !== 0) throw new Error(`回写失败: ${json.msg}`);
  return json.data;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-passcode",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
