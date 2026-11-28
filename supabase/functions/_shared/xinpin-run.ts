// 「新品推广 / 产品推广计划」脚本计算的编排（读飞书 → 计算 → 对比 / 回写）。
// 不含鉴权，不依赖 Deno 专有 API（只用 fetch），Edge Function 与本地 node 对拍脚本共用。
import { getTenantAccessToken, listSheets, readRange, writeValues } from "./feishu.ts";
import {
  type BdRow,
  type CellOut,
  type ClipRow,
  type Row,
  type USheet,
  calcChanpin,
  bdSitesFromXinpin,
  calcU,
  calcXinpin,
  colLetter,
  sameValue,
  toBdRows,
  toClipRows,
  trimText,
} from "./xinpin-calc.ts";

const FEISHU = "https://open.feishu.cn/open-apis";
/** 源表「达人建联登记表」：只读。写它必须显式 confirm_source_write。 */
const SOURCE_TOKEN = "ZWA7s1iqTh63j1t6PJfcuPnunBe";
/** 剪辑台账（小莫 / 王诗蔓 等剪辑师 sheet），即原 E/F 公式 IMPORTRANGE 的表。 */
const DEFAULT_CLIP_SPREADSHEET = "EHmlsMg33heiiOtb4kZcvpg8nJg";

export let apiCalls = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (u.startsWith(FEISHU)) apiCalls++;
  return origFetch(input, init);
}) as typeof fetch;

async function resolveToken(token: string, raw: string): Promise<string> {
  const s = raw.trim();
  const sheet = s.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheet) return sheet[1];
  const wiki = s.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!wiki) return s;
  const r = await fetch(`${FEISHU}/wiki/v2/spaces/get_node?token=${wiki[1]}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`wiki 节点解析失败（应用可能没有该知识库页面权限）：${j.msg}`);
  if (j.data?.node?.obj_type !== "sheet") throw new Error(`wiki 节点不是电子表格：${j.data?.node?.obj_type}`);
  return j.data.node.obj_token as string;
}

/** 读公式计算值。整本表重算期间飞书返回 90235 Data not ready → 等待重试，超时就报「公式未算完」。 */
async function readFormatted(token: string, ss: string, range: string, waitMs: number): Promise<Row[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await fetch(`${FEISHU}/sheets/v2/spreadsheets/${ss}/values/${encodeURIComponent(range)}?valueRenderOption=FormattedValue`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (j.code === 0) return (j.data?.valueRange?.values as Row[]) ?? [];
    if (j.code !== 90235 || Date.now() > deadline) {
      throw new Error(j.code === 90235 ? `公式未算完（${range} Data not ready），稍后再跑 dryrun` : `读取 ${range} 失败：${j.msg}`);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}


export type RunOptions = { isCron: boolean; env: (k: string) => string | undefined };

export async function runXinpin(body: Record<string, unknown>, opt: RunOptions) {
  const t0 = Date.now();
  apiCalls = 0;
  const isCron = opt.isCron;
  const mode = String(body.mode ?? (isCron ? "write" : "dryrun"));
  if (!["dryrun", "write", "compute"].includes(mode)) throw new Error(`mode 只能是 dryrun / write / compute`);
  if (isCron && mode !== "write") throw new Error("cron 只允许 write");
  const asked = Array.isArray(body.tables) && body.tables.length ? (body.tables as string[]) : ["xinpin", "chanpin"];
  // "u" = 各建联表「其他同事已建联」列（U 列），单独处理；其余是两张统计表
  const doU = asked.includes("u");
  const tables = asked.filter((t) => t === "xinpin" || t === "chanpin");
  // 写源表的许可：请求体 confirm_source_write 或环境变量 XINPIN_ALLOW_SOURCE_WRITE 等于源表 token
  const allowSource = body.confirm_source_write === SOURCE_TOKEN || opt.env("XINPIN_ALLOW_SOURCE_WRITE") === SOURCE_TOKEN;

  const token = await getTenantAccessToken();
  const dataRaw = (isCron ? "" : String(body.data_sheet ?? "")) || opt.env("XINPIN_DATA_SPREADSHEET") || "";
  if (!dataRaw) throw new Error("未指定数据表：传 data_sheet 或配置 env XINPIN_DATA_SPREADSHEET");
  const dataSS = await resolveToken(token, dataRaw);

  // listSheets 的返回里带 grid_properties.row_count：读建联表必须用它封顶，
  // 不能用开放区间——shared readRange 遇到连续 1200 行全空就停，林乐欣表中间就有这么大的空档，后面的数据会被静默丢掉。
  const sheets = (await listSheets(token, dataSS)) as Array<{ sheet_id: string; title: string; grid_properties?: { row_count?: number } }>;
  const sid = (title: string) => sheets.find((s) => s.title.trim() === title)?.sheet_id;
  const rowCount = (id: string) => sheets.find((s) => s.sheet_id === id)?.grid_properties?.row_count ?? 0;
  const need = (title: string) => {
    const id = sid(title);
    if (!id) throw new Error(`数据表里找不到 sheet「${title}」`);
    return id;
  };

  // 1) 读两张统计表的配置（值 + 公式模板）
  const cfg: Record<string, { sid: string; values: Row[]; formulas: Row[]; lastCol: string }> = {};
  // 配置/模板 sheet（读 A/B/D/G 列、第 2/3 行和统计格位置）；默认就是原 sheet，可传 xinpin_sheet / chanpin_sheet 覆盖
  const tableTitle: Record<string, string> = {
    xinpin: String(body.xinpin_sheet ?? "新品推广"),
    chanpin: String(body.chanpin_sheet ?? "产品推广计划"),
  };
  for (const t of tables) {
    const id = need(tableTitle[t]);
    const lastCol = t === "xinpin" ? "S" : "Z";
    const [values, formulas] = await Promise.all([
      readRange(token, dataSS, `${id}!A1:${lastCol}`, 4500 / 26 | 0),
      readRange(token, dataSS, `${id}!A1:${lastCol}`, 4500 / 26 | 0, "Formula"),
    ]);
    cfg[t] = { sid: id, values, formulas, lastCol };
  }

  // 2) 需要哪些建联表：两张表第 2 行出现的同事名
  const names = new Set<string>();
  for (const t of tables) for (const v of cfg[t].values[1] ?? []) {
    const n = trimText(v);
    if (n && sid(`建联-${n}`)) names.add(n);
  }
  const bd: Record<string, BdRow[]> = {};
  const bdStat: Record<string, number> = {};
  await Promise.all([...names].map(async (n) => {
    const id = need(`建联-${n}`);
    const rc = rowCount(id);
    if (rc < 3) throw new Error(`建联-${n} 读不到行数`);
    const rows = await readRange(token, dataSS, `${id}!A3:P${rc}`, 300);
    bdStat[n] = rows.length;
    bd[n] = toBdRows(rows);
  }));

  // 3) 剪辑台账（新品推广 E/F）。来源：请求 clip_sheet → 原公式里 IMPORTRANGE 的链接 → env → 默认表。
  //    公式被换成数值后就没有 IMPORTRANGE 可抄了，所以必须有默认值；读不到就报错，不能静默写「无素材」。
  const clips: Record<string, ClipRow[]> = {};
  if (tables.includes("xinpin")) {
    const row2 = cfg.xinpin.values[1] ?? [];
    const row3 = cfg.xinpin.values[2] ?? [];
    const editors = new Set<string>();
    row3.forEach((v, c) => {
      if (trimText(v) === "剪辑素材数量" && trimText(row2[c])) editors.add(trimText(row2[c]));
    });
    cfg.xinpin.formulas.slice(3).forEach((fr) => fr?.forEach((x, c) => {
      if (typeof x === "string" && x.includes("IMPORTRANGE") && trimText(row2[c])) editors.add(trimText(row2[c]));
    }));
    if (editors.size) {
      const f = cfg.xinpin.formulas.slice(3).flat().find((x) => typeof x === "string" && x.includes("IMPORTRANGE")) as string | undefined;
      const clipRaw = String(body.clip_sheet ?? "") || f?.match(/IMPORTRANGE\("([^"]+)"/)?.[1] || opt.env("XINPIN_CLIP_SPREADSHEET") ||
        DEFAULT_CLIP_SPREADSHEET;
      const clipSS = await resolveToken(token, clipRaw);
      const clipSheets = (await listSheets(token, clipSS)) as Array<{ sheet_id: string; title: string; grid_properties?: { row_count?: number } }>;
      await Promise.all([...editors].map(async (e) => {
        const s = clipSheets.find((x) => x.title.trim() === e);
        if (!s) throw new Error(`剪辑台账里找不到 sheet「${e}」`);
        const rc = s.grid_properties?.row_count ?? 0;
        if (rc < 3) throw new Error(`剪辑台账「${e}」读不到行数`);
        clips[e] = toClipRows(await readRange(token, clipSS, `${s.sheet_id}!A3:G${rc}`, 700));
      }));
    }
  }

  // 4) 计算
  const result: Record<string, CellOut[]> = {};
  if (cfg.xinpin) result.xinpin = calcXinpin(cfg.xinpin.values, cfg.xinpin.formulas, bd, clips);
  if (cfg.chanpin) {
    const xv = cfg.xinpin?.values ?? (await readRange(token, dataSS, `${need(tableTitle.xinpin)}!A1:S3`));
    result.chanpin = calcChanpin(cfg.chanpin.values, cfg.chanpin.formulas, bd, bdSitesFromXinpin(xv));
  }
  const tCalc = Date.now();

  const report: Record<string, unknown> = {};
  if (mode === "dryrun") {
    const cmp = (body.compare ?? {}) as Record<string, string>;
    const waitMs = Number(body.wait_ms ?? 60000);
    for (const t of Object.keys(result)) {
      const title = cmp[t] ?? tableTitle[t];
      const csid = need(title);
      const cells = result[t];
      const maxRow = Math.max(...cells.map((c) => c.row));
      const fv = await readFormatted(token, dataSS, `${csid}!A1:${cfg[t].lastCol}${maxRow}`, waitMs);
      const diffs = cells
        .filter((c) => !sameValue(fv[c.row - 1]?.[c.col], c.value))
        .map((c) => [c.cell, fv[c.row - 1]?.[c.col] ?? null, c.value]);
      report[t] = { compared_with: title, cells: cells.length, same: cells.length - diffs.length, diffs };
    }
  } else if (mode === "write" && tables.length) {
    const tgtRaw = (isCron ? "" : String(body.target_sheet ?? "")) || opt.env("XINPIN_TARGET_SPREADSHEET") || "";
    if (!tgtRaw) throw new Error("未指定回写目标：传 target_sheet 或配置 env XINPIN_TARGET_SPREADSHEET");
    const tgtSS = await resolveToken(token, tgtRaw);
    if (tgtSS === SOURCE_TOKEN && !allowSource) {
      throw new Error("拒绝写源表「达人建联登记表」：如确需写入，confirm_source_write 填源表 token");
    }
    const tgtSheets = tgtSS === dataSS ? sheets : await listSheets(token, tgtSS);
    const targets: Record<string, string> = {
      xinpin: String(body.xinpin_target ?? "新品推广-脚本"),
      chanpin: String(body.chanpin_target ?? "产品推广计划-脚本"),
    };
    for (const t of Object.keys(result)) {
      const s = tgtSheets.find((x) => x.title.trim() === targets[t]);
      if (!s) throw new Error(`目标表里找不到 sheet「${targets[t]}」`);
      // 按行拼成连续区间写：每行取最小~最大列，中间不属于统计的格子保留原值不覆盖 → 逐段写。
      const ranges: Array<{ range: string; values: unknown[][] }> = [];
      const byRow = new Map<number, CellOut[]>();
      for (const c of result[t]) byRow.set(c.row, [...(byRow.get(c.row) ?? []), c]);
      for (const [row, cs] of byRow) {
        cs.sort((a, b) => a.col - b.col);
        let seg: CellOut[] = [];
        const flush = () => {
          if (!seg.length) return;
          ranges.push({
            range: `${s.sheet_id}!${colLetter(seg[0].col)}${row}:${colLetter(seg[seg.length - 1].col)}${row}`,
            values: [seg.map((x) => x.value)],
          });
          seg = [];
        };
        for (const c of cs) {
          if (seg.length && c.col !== seg[seg.length - 1].col + 1) flush();
          seg.push(c);
        }
        flush();
      }
      for (let i = 0; i < ranges.length; i += 200) await writeValues(token, tgtSS, ranges.slice(i, i + 200));
      report[t] = { target: targets[t], cells: result[t].length, ranges: ranges.length };
    }
  }

  // 5) 建联表 U 列「其他同事已建联」：直接读所有「建联-*」表 A:D 计算，不再依赖「建联动态汇总」
  if (doU) {
    const uSheets = sheets.filter((x) => /^建联-/.test(x.title.trim()));
    const data: USheet[] = [];
    const meta: Record<string, { sid: string; col: number; rc: number }> = {};
    await Promise.all(uSheets.map(async (x) => {
      const rc = x.grid_properties?.row_count ?? 0;
      if (rc < 3) return;
      const head = await readRange(token, dataSS, `${x.sheet_id}!A2:AZ2`);
      const col = (head[0] ?? []).findIndex((v) => trimText(v) === "其他同事已建联");
      if (col < 0) return; // 没有这一列的表只当数据源，不写
      meta[x.title.trim()] = { sid: x.sheet_id, col, rc };
    }));
    // 数据源 = 所有建联表（含没有 U 列的），按 sheet 顺序
    const rowsBy = await Promise.all(uSheets.map(async (x) => {
      const rc = x.grid_properties?.row_count ?? 0;
      return rc < 3 ? [] : await readRange(token, dataSS, `${x.sheet_id}!A3:D${rc}`, 1000);
    }));
    uSheets.forEach((x, i) => data.push({ name: x.title.trim(), rows: rowsBy[i] }));
    const uOut = calcU(data);
    // readRange 会去掉表尾空行；补齐到表格行数，保证写回时整列覆盖（空行写空值）
    for (const x of uSheets) {
      const n = Math.max(0, (x.grid_properties?.row_count ?? 0) - 2);
      const arr = uOut[x.title.trim()] ?? [];
      while (arr.length < n) arr.push("");
      uOut[x.title.trim()] = arr;
    }
    const uRep: Record<string, unknown> = {};
    if (mode === "dryrun") {
      const waitMs = Number(body.wait_ms ?? 60000);
      for (const [name, m] of Object.entries(meta)) {
        const L = colLetter(m.col);
        const want = uOut[name] ?? [];
        const fv = await readFormatted(token, dataSS, `${m.sid}!${L}3:${L}${m.rc}`, waitMs);
        const diffs: unknown[] = [];
        want.forEach((v, i) => {
          if (!sameValue(fv[i]?.[0], v)) diffs.push([`${L}${i + 3}`, fv[i]?.[0] ?? null, v]);
        });
        uRep[name] = { rows: want.length, same: want.length - diffs.length, diffs: diffs.slice(0, 50), diff_count: diffs.length };
      }
    } else if (mode === "write") {
      if (dataSS === SOURCE_TOKEN && !allowSource) {
        throw new Error("拒绝写源表「达人建联登记表」的 U 列：如确需写入，confirm_source_write 填源表 token 或配置 XINPIN_ALLOW_SOURCE_WRITE");
      }
      const rowsByName = Object.fromEntries(data.map((d) => [d.name, d.rows]));
      for (const [name, m] of Object.entries(meta)) {
        const L = colLetter(m.col);
        // 防错位：写之前再读一次 D 列（用户名），和计算时读到的逐行比对；
        // 读→写之间有人插行/删行就跳过这张表，下一轮（10 分钟后）再写。
        const dNow = await readRange(token, dataSS, `${m.sid}!D3:D${m.rc}`, 4500);
        const before = rowsByName[name] ?? [];
        const moved = Math.max(dNow.length, before.length) > 0 &&
          Array.from({ length: Math.max(dNow.length, before.length) }).some((_, i) => trimText(dNow[i]?.[0]) !== trimText(before[i]?.[3]));
        if (moved) {
          uRep[name] = { column: L, skipped: "读取后表格有改动（插行/删行/改用户名），本轮跳过" };
          continue;
        }
        const vals = (uOut[name] ?? []).map((v) => [v]);
        // 整列写到表格最后一行：原来空行里也铺满了 U 公式（每格都会去扫汇总表），必须一起清成值
        const last = vals.length;
        for (let i = 0; i < last; i += 4000) {
          await writeValues(token, dataSS, [{ range: `${m.sid}!${L}${3 + i}:${L}${3 + Math.min(last, i + 4000) - 1}`, values: vals.slice(i, Math.min(last, i + 4000)) }]);
        }
        uRep[name] = { column: L, rows_written: last };
      }
    }
    report.u = uRep;
    if (mode === "compute") (result as Record<string, unknown>).u = uOut;
  }

  return {
    ok: true,
    mode,
    elapsed_ms: Date.now() - t0,
    calc_ms: tCalc - t0,
    feishu_api_calls: apiCalls,
    bd_rows: bdStat,
    clip_rows: Object.fromEntries(Object.entries(clips).map(([k, v]) => [k, v.length])),
    report,
    ...(mode === "compute" ? { result } : {}),
  };
}
