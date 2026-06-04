// Write authorize result back to Feishu sheet.
// P = 投放日期 (今天日期，yyyy/mm/dd)
// Q = 状态文本 (中文，无英文 API 报错)
//
// Additionally, log "已授权" entries to the "授权记录" sheet.
// Columns: A 序号 | B 国家 | C 达人名字 | D VID | E 视频CODE | F 产品
//          G 投放时间 (YYYYMMDD HH:MM:SS) | H 投手备注 | I 同事
// Match existing rows by VID + 视频CODE (D + E). Update in place if found,
// otherwise append. Feishu auto-extends rows.

import {
  appendValues,
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
  writeValues,
} from "../_shared/feishu.ts";
import { checkAdminPasscode } from "../_shared/auth.ts";

type Item = {
  sheet_name: string;
  row_number: number;
  status: string;
  error_message?: string;
  // log fields (optional, used when status === "已授权")
  country?: string;
  creator_name?: string;
  vid?: string;
  auth_code?: string;
  product?: string;
  staff_name?: string;
};

const LOG_SHEET_TITLE = "授权记录";

function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function nowTs(): string {
  // YYYYMMDD HH:MM:SS in UTC+8 (Beijing time) — matches likely user timezone.
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${da} ${hh}:${mm}:${ss}`;
}

// Only these statuses write to Q column.
const Q_STATUSES = new Set([
  "代码有误",
  "代码删除",
  "代码过期",
  "代码涉及多素材",
  "视频不可见",
]);

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
    const dateStr = todayDate();

    // ----- 1) P/Q writeback on source sheets -----
    const valueRanges = items.flatMap((it) => {
      const sid = sheetByName.get(it.sheet_name);
      if (!sid) return [];
      if (it.status === "已授权") {
        return [{
          range: `${sid}!P${it.row_number}:P${it.row_number}`,
          values: [[dateStr]],
        }];
      }
      if (Q_STATUSES.has(it.status)) {
        return [
          {
            range: `${sid}!P${it.row_number}:P${it.row_number}`,
            values: [[dateStr]],
          },
          {
            range: `${sid}!Q${it.row_number}:Q${it.row_number}`,
            values: [[it.status]],
          },
        ];
      }
      return [];
    });

    if (valueRanges.length > 0) {
      await writeValues(token, spreadsheetToken, valueRanges);
    }

    // ----- 2) Append/Update "授权记录" sheet for ALL auth-status items -----
    const logItems = items.filter((it) => it.vid && it.auth_code);
    let logged = 0;
    const logSid = sheetByName.get(LOG_SHEET_TITLE);
    if (logItems.length > 0 && logSid) {
      // Read existing rows (A2:I) to build vid+code -> row map and find max 序号.
      const existing = await readRange(token, spreadsheetToken, `${logSid}!A2:I`);
      const keyToRow = new Map<string, number>(); // key -> row_number (1-indexed)
      let maxSeq = 0;
      existing.forEach((row, idx) => {
        const seq = Number(row?.[0]);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
        const vid = String(row?.[3] ?? "").trim();
        const code = String(row?.[4] ?? "").trim();
        if (vid && code) keyToRow.set(`${vid}__${code}`, idx + 2);
      });

      const ts = nowTs();
      const updates: Array<{ range: string; values: unknown[][] }> = [];
      const appends: unknown[][] = [];

      // Column H 投手备注: encode status (+ error message for API错误).
      const buildNote = (it: Item) => {
        if (it.status === "已授权") return "";
        if (it.status === "API错误") {
          return it.error_message ? `${it.status}: ${it.error_message}` : it.status;
        }
        return it.status;
      };

      for (const it of logItems) {
        const key = `${it.vid}__${it.auth_code}`;
        const note = buildNote(it);
        const existingRow = keyToRow.get(key);
        if (existingRow != null && existingRow > 0) {
          updates.push({
            range: `${logSid}!B${existingRow}:I${existingRow}`,
            values: [[
              it.country ?? "",
              it.creator_name ?? "",
              it.vid ?? "",
              it.auth_code ?? "",
              it.product ?? "",
              ts,
              note,
              it.staff_name ?? "",
            ]],
          });
        } else {
          maxSeq += 1;
          appends.push([
            maxSeq,
            it.country ?? "",
            it.creator_name ?? "",
            it.vid ?? "",
            it.auth_code ?? "",
            it.product ?? "",
            ts,
            note,
            it.staff_name ?? "",
          ]);
          keyToRow.set(key, -1);
        }
      }

      if (updates.length > 0) {
        await writeValues(token, spreadsheetToken, updates);
      }
      if (appends.length > 0) {
        await appendValues(
          token,
          spreadsheetToken,
          `${logSid}!A1:I1`,
          appends,
        );
      }
      logged = updates.length + appends.length;
    } else if (logItems.length > 0 && !logSid) {
      console.warn(`授权记录 sheet 未找到，跳过执行记录回写`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        updated: items.length,
        cells: valueRanges.length,
        logged,
      }),
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
