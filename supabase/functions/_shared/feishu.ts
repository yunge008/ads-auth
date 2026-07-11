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

export function getSpreadsheetToken(envName = "FEISHU_SPREADSHEET_TOKEN"): string {
  const raw = Deno.env.get(envName) ?? "";
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
  chunkRows?: number, // rows per request; keep rows*cols under Feishu's ~5000-cell cap
) {
  // Feishu values v2 caps a single response at ~5000 cells.
  // For open-ended ranges (e.g. "A2:G") we paginate by row chunks until empty.
  const m = range.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d*)$/);
  if (!m) return await readRangeOnce(token, spreadsheetToken, range);
  const [, sid, colStart, rowStartStr, colEnd, rowEndStr] = m;
  const startRow = parseInt(rowStartStr, 10);
  const endRow = rowEndStr ? parseInt(rowEndStr, 10) : 0; // 0 = open-ended
  const CHUNK = chunkRows && chunkRows > 0 ? chunkRows : 500; // default: 500 rows * ~8 cols = 4000 cells
  const out: unknown[][] = [];
  let cur = startRow;
  let emptyStreak = 0;
  const MAX_EMPTY_CHUNKS = 4; // tolerate ~2000 blank rows before stopping on open-ended ranges
  while (true) {
    const stop = endRow ? Math.min(cur + CHUNK - 1, endRow) : cur + CHUNK - 1;
    const r = `${sid}!${colStart}${cur}:${colEnd}${stop}`;
    const chunk = await readRangeOnce(token, spreadsheetToken, r);
    // Keep all rows (including internal blanks) so absolute row indices line up.
    out.push(...chunk);
    const hasContent = chunk.some((row) => (row ?? []).some((c) => c != null && String(c).trim() !== ""));
    if (hasContent) {
      emptyStreak = 0;
    } else {
      emptyStreak++;
    }
    if (endRow && stop >= endRow) break;
    // For open-ended ranges: stop only after several consecutive fully-empty chunks,
    // or when the API returns fewer rows than requested (end of sheet).
    if (!endRow && (emptyStreak >= MAX_EMPTY_CHUNKS || chunk.length < CHUNK)) break;
    cur = stop + 1;
  }
  // Trim trailing fully-empty rows from final result
  let lastNonEmpty = -1;
  for (let i = 0; i < out.length; i++) {
    const row = out[i] ?? [];
    if (row.some((c) => c != null && String(c).trim() !== "")) lastNonEmpty = i;
  }
  return out.slice(0, lastNonEmpty + 1);
}

async function readRangeOnce(token: string, spreadsheetToken: string, range: string) {
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

// Append rows after the last filled row in the given range.
// Uses OVERWRITE (not INSERT_ROWS): writes into blank cells below without
// inserting whole sheet rows — INSERT_ROWS would shift other column regions
// on the same sheet (e.g. 「授权记录」 keeps its legacy archive in K:Q).
export async function appendValues(
  token: string,
  spreadsheetToken: string,
  range: string, // e.g. "<sheet_id>!A1:I1"
  values: unknown[][],
) {
  const res = await fetch(
    `${FEISHU_BASE}/sheets/v2/spreadsheets/${spreadsheetToken}/values_append?insertDataOption=OVERWRITE`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ valueRange: { range, values } }),
    },
  );
  const json = await res.json();
  if (json.code !== 0) throw new Error(`追加行失败: ${json.msg}`);
  return json.data;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-passcode, x-admin-name, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
