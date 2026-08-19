// Write authorize result back to Feishu sheet (建联-xxx layout).
// V = 投放日期 (今天日期，yyyy/mm/dd)
// W = 状态文本 (中文，无英文 API 报错)
//
// Additionally, log every auth-status item to the "授权记录" sheet.
// Columns: A 序号 | B 国家 | C 达人名字 | D VID | E 视频CODE | F 产品
//          G 投放时间 (YYYYMMDD HH:MM:SS) | H 投手备注 | I 同事
//          J 广告户名称 | K 广告户ID
// A:K 是一个整体的实时执行记录块。每次授权都是一条新记录，不按 VID+授权码
// 去重覆盖——同一个 VID+授权码 换广告户重新授权、或重试，都各自留痕，能看到
// 完整历史。序号 = 表内最大值 + 1。
// 历史冻结归档区已从 K:Q 挪到 M:S（M=BD N=登记日期 O=国家 P=达人名字 Q=VID
// R=授权码 S=产品，见 feishu-read 的 include_done 分支 / attribution-sync-creators），
// 腾出 J:K 给本次新增的广告户名称/ID，L 是二者之间的空列缓冲。
// Feishu auto-extends rows (values_append, OVERWRITE，不整行插入避免顶移
// 同 sheet 的 M:S 归档区）。

import {
  appendValues,
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
  writeValues,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

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
  advertiser_name?: string;
  advertiser_id?: string;
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

// Only these statuses write to W column.
const W_STATUSES = new Set([
  "代码有误",
  "代码删除",
  "代码过期",
  "代码涉及多素材",
  "视频不可见",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const cronKey = req.headers.get("x-cron-key") ?? "";
    let cronAuthed = false;
    if (cronKey) {
      const { data: ok } = await admin().rpc("verify_gmv_cron_key", { _key: cronKey });
      if (ok === true) cronAuthed = true;
    }
    if (!cronAuthed) await checkAdminPasscode(req, "home");
    const { items } = (await req.json()) as { items: Item[] };
    if (!items?.length) throw new Error("items 不能为空");

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken();
    const sheets = await listSheets(token, spreadsheetToken);
    const sheetByName = new Map(sheets.map((s) => [s.title, s.sheet_id]));
    const dateStr = todayDate();

    // ----- 1) V/W writeback on source sheets -----
    const valueRanges = items.flatMap((it) => {
      // Archive rows (sourced from 「授权记录」!M3:S, frozen table) have no
      // writeback target — they are only logged to the A:K execution log below.
      if (it.sheet_name === LOG_SHEET_TITLE) return [];
      const sid = sheetByName.get(it.sheet_name);
      if (!sid) return [];
      if (it.status === "已授权") {
        return [{
          range: `${sid}!V${it.row_number}:V${it.row_number}`,
          values: [[dateStr]],
        }];
      }
      if (W_STATUSES.has(it.status)) {
        return [
          {
            range: `${sid}!V${it.row_number}:V${it.row_number}`,
            values: [[dateStr]],
          },
          {
            range: `${sid}!W${it.row_number}:W${it.row_number}`,
            values: [[it.status]],
          },
        ];
      }
      return [];
    });

    if (valueRanges.length > 0) {
      await writeValues(token, spreadsheetToken, valueRanges);
    }

    // ----- 2) Append a NEW log row for every auth-status item (不去重覆盖) -----
    const logItems = items.filter((it) => it.vid && it.auth_code);
    let logged = 0;
    const logSid = sheetByName.get(LOG_SHEET_TITLE);
    if (logItems.length > 0 && logSid) {
      // 只需要 A 列（序号）来算当前行数 + 最大序号；不再按 VID+授权码 去重，
      // 每次授权（含换广告户重授权、重试）都各留一行历史记录。
      const existing = await readRange(token, spreadsheetToken, `${logSid}!A2:A`);
      let maxSeq = 0;
      for (const row of existing) {
        const seq = Number(row?.[0]);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
      }

      const ts = nowTs();
      // Column H 投手备注: encode status (+ error message for API错误).
      const buildNote = (it: Item) => {
        if (it.status === "API错误") {
          return it.error_message ? `${it.status}: ${it.error_message}` : it.status;
        }
        return it.status;
      };

      const appends: unknown[][] = logItems.map((it) => {
        maxSeq += 1;
        return [
          maxSeq,
          it.country ?? "",
          it.creator_name ?? "",
          it.vid ?? "",
          it.auth_code ?? "",
          it.product ?? "",
          ts,
          buildNote(it),
          it.staff_name ?? "",
        ];
      });
      const advAppends: unknown[][] = logItems.map((it) => [
        it.advertiser_name ?? "",
        it.advertiser_id ?? "",
      ]);

      // Append starting from the first empty row; range height must be >= rows being appended.
      const startRow = existing.length + 2;
      const endRow = startRow + appends.length - 1;
      await appendValues(token, spreadsheetToken, `${logSid}!A${startRow}:I${endRow}`, appends);
      // 广告户名称/ID 写到 J:K，紧接 A:I 组成完整的 A:K 实时记录块；
      // 历史归档区已挪到 M:S，这里不会碰到它。
      await appendValues(token, spreadsheetToken, `${logSid}!J${startRow}:K${endRow}`, advAppends);
      logged = appends.length;
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
