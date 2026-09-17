// 同步飞书达人登记 3 处数据 → creator_registry，并做保护期归属解析 → creator_ownership。
// 数据源：
//   1. BD 建联表（FEISHU_SPREADSHEET_TOKEN，「建联-姓名」sheets，含离职）
//      A=BD B=发样日期 C=国家 D=用户名 E=昵称 K=SKU N=登记日期 P=VID
//   2. 「授权记录」归档 M3:S（同表格，J:K 现为广告户名称/ID）：M=BD N=登记日期 O=国家 P=达人名字 Q=VID
//   3. 剪辑表（FEISHU_EDITOR_SPREADSHEET_TOKEN）：B=同事 C=日期 D=国家 E=账号 F=SKU G=VID
// Body: { sheets?: string[], resolve_only?: boolean }
//   · 不传    → 从头开始，按时间预算能跑多少 sheet 跑多少
//   · sheets  → 只处理这几个 sheet（续跑用，调用方把上次返回的 remaining 传回来）
//   · resolve_only → 跳过读飞书，只做「归属解析 + 重建 creator_ownership」这一步
//
// 【为什么要分片】Supabase Edge Function 有 150 秒墙钟上限，超了直接被平台掐断，
// 连错误体都返回不了（前端只看到「非 2XX」）。登记数据涨到六万行后，
// 「读十来个飞书 sheet + 全量重建登记表 + 解析归属 + 重建归属表」一次做完必然超时。
// 现在按 sheet 分片：每片先删后插自己那个 source_sheet 的行（粒度安全，中断不会留下半张表），
// 时间预算用完就返回 remaining，由调用方（前端/cron）继续调，全部 sheet 处理完才做归属解析。
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { cellText, isPrecisionLostNumber, parseDate } from "../_shared/cells.ts";
import {
  type RegistryEntry,
  type ReviewItem,
  hasCjk,
  identityKey,
  isHeaderLikeSite,
  normalizeSiteCode,
  normalizeName,
  resolveOwnership,
} from "../_shared/attribution.ts";
import { persistRunArtifacts } from "../_shared/attribution-report.ts";

const VID_RE = /^7\d{18}$/;

/** 表头里认这些词就是「粉丝量」列（前台暂不展示，先把数据存下来）。 */
const FOLLOWER_HEADER_RE = /(粉丝|fans|follower)/i;

/**
 * 粉丝量单元格 → 整数。兼容「12.3万」「1.2w」「850K」「1,234」这些写法。
 * 存的是绝对值，前台要按 K 显示时自己除。
 */
function parseFollowerCount(v: unknown): number | null {
  const raw = cellText(v);
  if (!raw) return null;
  const t = raw.normalize("NFKC").replace(/[\s,]/g, "");
  const m = t.match(/^([\d.]+)\s*(万|w|W|k|K|m|M)?/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const unit = m[2] ?? "";
  const mult = unit === "万" || unit === "w" || unit === "W" ? 10000
    : unit === "k" || unit === "K" ? 1000
    : unit === "m" || unit === "M" ? 1000000
    : 1;
  const n = Math.round(base * mult);
  return n >= 0 && n < 1e12 ? n : null;
}
const LOG_SHEET_TITLE = "授权记录";

type RegRow = {
  source: "JIANLIAN" | "ARCHIVE" | "EDITOR";
  source_sheet: string;
  row_number: number;
  role: "BD" | "EDITOR";
  staff_name: string;
  staff_active: boolean;
  register_date: string | null;
  sample_date: string | null;
  country: string;
  handle_raw: string;
  handle_norm: string;
  nickname_raw: string;
  nickname_norm: string;
  vid: string;
  registered_sku: string | null;
  follower_count: number | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // cron 免口令：pg_cron 经服务端路由 /api/public/hooks/feishu-sync-cron 带上 x-cron-key（vault secret）。
    // 本函数只读飞书 + 重建自己库里的登记/归属表，不回写飞书。
    if (!(await cronAuthed(req))) await checkAdminPasscode(req, "gmv-attribution-admin");
    const db = admin();
    const body = (await req.json().catch(() => ({}))) as { sheets?: string[]; resolve_only?: boolean };
    const onlySheets = Array.isArray(body.sheets) && body.sheets.length ? new Set(body.sheets) : null;
    const resolveOnly = !!body.resolve_only;

    // 时间预算：平台 150 秒硬上限，留 40 秒余量，做完一个 sheet 就检查一次。
    const T0 = Date.now();
    const BUDGET_MS = 110_000;
    /** 归属解析（读全表 + 解析 + 重建归属表）至少要留这么多时间，不够就让调用方再调一次 */
    const RESOLVE_MIN_MS = 55_000;
    const leftMs = () => BUDGET_MS - (Date.now() - T0);

    // 全部人员（含离职 active=false），归因需要覆盖历史数据
    const { data: staffRows, error: staffErr } = await db
      .from("staff_sheets")
      .select("name, sheet_name, active, role");
    if (staffErr) throw new Error(staffErr.message);
    const staff = (staffRows ?? []) as { name: string; sheet_name: string; active: boolean; role: string }[];
    const activeByName = new Map(staff.map((s) => [s.name, !!s.active]));

    const token = await getTenantAccessToken();
    const missing: string[] = [];
    /** VID 单元格被飞书按数字返回导致丢精度的次数（读取已统一走 ToString，这里是最后一道保险） */
    let vidPrecisionLost = 0;
    /** 含汉字的站点写法（站点统一用英文简写，汉字永远匹配不上，必须回飞书改） */
    const cjkSites = new Map<string, number>();
    const readSite = (cell: unknown): string => {
      const raw = cellText(cell);
      // 表头/占位单元格（「地区/店铺」这类）不是站点，既不上报也不入库
      if (isHeaderLikeSite(raw)) return "";
      // 先套等效写法映射（PH本土 → PHL），映射完仍含汉字才算填错
      const site = normalizeSiteCode(raw);
      if (site && hasCjk(site)) cjkSites.set(site, (cjkSites.get(site) ?? 0) + 1);
      return site;
    };
    /** 读一个 VID 单元格：丢精度的直接当空处理，避免把错的 VID 写进登记表 */
    const readVid = (cell: unknown): string => {
      if (isPrecisionLostNumber(cell)) {
        vidPrecisionLost++;
        return "";
      }
      const raw = cellText(cell);
      return VID_RE.test(raw) ? raw : "";
    };
    // ---- 工作清单：一个 sheet 一片，按顺序处理，时间用完就交给下一次调用 ----
    const mainToken = getSpreadsheetToken();
    const mainSheets = await listSheets(token, mainToken);
    const mainByName = new Map(mainSheets.map((s) => [s.title, s.sheet_id]));
    const editors = staff.filter((s) => s.role === "EDITOR");
    let edByName = new Map<string, string>();
    let edToken = "";
    if (editors.length) {
      edToken = getSpreadsheetToken("FEISHU_EDITOR_SPREADSHEET_TOKEN");
      edByName = new Map((await listSheets(token, edToken)).map((s) => [s.title, s.sheet_id]));
    }

    type Job = { sheet: string; kind: "JIANLIAN" | "ARCHIVE" | "EDITOR"; staffName: string; active: boolean };
    const jobs: Job[] = [
      ...staff.filter((s) => s.role === "BD").map((t): Job => ({ sheet: t.sheet_name, kind: "JIANLIAN", staffName: t.name, active: !!t.active })),
      { sheet: LOG_SHEET_TITLE, kind: "ARCHIVE", staffName: "", active: false },
      ...editors.map((t): Job => ({ sheet: t.sheet_name, kind: "EDITOR", staffName: t.name, active: !!t.active })),
    ];
    const todo = onlySheets ? jobs.filter((j) => onlySheets.has(j.sheet)) : jobs;

    /** 处理完一个 sheet 就把它那一段登记行先删后插：中断也不会留下半张表 */
    const rewriteSheet = async (sheetName: string, rows: RegRow[]) => {
      const { error: delErr } = await db.from("creator_registry").delete().eq("source_sheet", sheetName);
      if (delErr) throw new Error(`删除 ${sheetName} 旧登记行失败：${delErr.message}`);
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("creator_registry").insert(rows.slice(i, i + 500));
        if (error) throw new Error(`写入 ${sheetName} 登记行失败：${error.message}`);
      }
    };

    const processed: string[] = [];
    let remaining: string[] = [];
    let writtenRows = 0;
    let writtenVidRows = 0;
    let followerRows = 0;

    if (!resolveOnly) {
      for (let ji = 0; ji < todo.length; ji++) {
        const job = todo[ji];
        // 预算用完 → 剩下的交给下一次调用。判断放在每个 sheet 开头，保证当前 sheet 要么没开始、要么整段写完。
        if (leftMs() < 20_000) {
          remaining = todo.slice(ji).map((j) => j.sheet);
          break;
        }
        const rows: RegRow[] = [];

        if (job.kind === "JIANLIAN") {
          const sid = mainByName.get(job.sheet);
          if (!sid) {
            missing.push(job.sheet);
            continue;
          }
          // 先读表头找「粉丝量」列：各人的建联表列位并不完全一致，写死列号迟早读错
          let followerIdx = -1;
          try {
            const header = await readRange(token, mainToken, `${sid}!A1:Z1`);
            followerIdx = (header[0] ?? []).findIndex((c) => FOLLOWER_HEADER_RE.test(cellText(c)));
          } catch {
            /* 读不到表头就当没有粉丝量列，不影响主流程 */
          }
          // 26 列 × 180 行 ≈ 4680 cells，低于飞书 ~5000 上限
          const raw = await readRange(token, mainToken, `${sid}!A2:Z`, 180);
          for (let i = 0; i < raw.length; i++) {
            const r = raw[i] ?? [];
            const handleRaw = cellText(r[3]);
            const nicknameRaw = cellText(r[4]);
            const vid = readVid(r[15]);
            const handleNorm = normalizeName(handleRaw);
            const nicknameNorm = normalizeName(nicknameRaw);
            if (!handleNorm && !nicknameNorm && !vid) continue;
            rows.push({
              source: "JIANLIAN",
              source_sheet: job.sheet,
              row_number: i + 2,
              role: "BD",
              staff_name: job.staffName,
              staff_active: job.active,
              register_date: parseDate(r[13]),
              sample_date: parseDate(r[1]),
              country: readSite(r[2]),
              handle_raw: handleRaw,
              handle_norm: handleNorm,
              nickname_raw: nicknameRaw,
              nickname_norm: nicknameNorm,
              vid,
              registered_sku: cellText(r[10]) || null,
              follower_count: followerIdx >= 0 ? parseFollowerCount(r[followerIdx]) : null,
            });
          }
        } else if (job.kind === "ARCHIVE") {
          const sid = mainByName.get(LOG_SHEET_TITLE);
          if (!sid) {
            missing.push(LOG_SHEET_TITLE);
            continue;
          }
          const raw = await readRange(token, mainToken, `${sid}!M3:S`);
          for (let i = 0; i < raw.length; i++) {
            const r = raw[i] ?? [];
            const bd = cellText(r[0]) || "原数据";
            const nicknameRaw = cellText(r[3]);
            const vid = readVid(r[4]);
            const nicknameNorm = normalizeName(nicknameRaw);
            if (!nicknameNorm && !vid) continue;
            rows.push({
              source: "ARCHIVE",
              source_sheet: LOG_SHEET_TITLE,
              row_number: i + 3,
              role: "BD",
              staff_name: bd,
              staff_active: activeByName.get(bd) ?? false,
              register_date: parseDate(r[1]),
              sample_date: null,
              country: readSite(r[2]),
              handle_raw: "",
              handle_norm: "",
              nickname_raw: nicknameRaw,
              nickname_norm: nicknameNorm,
              vid,
              registered_sku: cellText(r[6]) || null,
              follower_count: null,
            });
          }
        } else {
          const sid = edByName.get(job.sheet);
          if (!sid) {
            missing.push(job.sheet);
            continue;
          }
          const raw = await readRange(token, edToken, `${sid}!A2:H`);
          for (let i = 0; i < raw.length; i++) {
            const r = raw[i] ?? [];
            const who = cellText(r[1]);
            if (!who || who !== job.staffName) continue; // 与 feishu-read-editors 同规则：B 列同事须等于表名对应姓名
            const vid = readVid(r[6]);
            if (!vid) continue;
            const acctRaw = cellText(r[4]);
            rows.push({
              source: "EDITOR",
              source_sheet: job.sheet,
              row_number: i + 2,
              role: "EDITOR",
              staff_name: job.staffName,
              staff_active: job.active,
              register_date: parseDate(r[2]),
              sample_date: null,
              country: readSite(r[3]),
              handle_raw: "",
              handle_norm: "",
              nickname_raw: acctRaw,
              nickname_norm: normalizeName(acctRaw),
              vid,
              registered_sku: cellText(r[5]) || null,
              follower_count: null,
            });
          }
        }

        await rewriteSheet(job.sheet, rows);
        processed.push(job.sheet);
        writtenRows += rows.length;
        writtenVidRows += rows.filter((r) => r.vid).length;
        followerRows += rows.filter((r) => r.follower_count != null).length;
      }
    }

    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const cjkList = Array.from(cjkSites.entries())
      .map(([site, rows]) => ({ site, rows }))
      .sort((a, b) => b.rows - a.rows)
      .slice(0, 20);

    // 还有 sheet 没读完，或者剩余时间不够做归属解析 → 先回一趟，让调用方续跑
    if (remaining.length || (!resolveOnly && leftMs() < RESOLVE_MIN_MS)) {
      return json({
        done: false,
        phase: "READ",
        processed,
        remaining,
        // remaining 为空但时间不够 → 下一次只需要做归属解析
        next: remaining.length ? { sheets: remaining } : { resolve_only: true },
        registry_rows: writtenRows,
        registry_vid_rows: writtenVidRows,
        follower_rows: followerRows,
        missing_sheets: missing,
        vid_precision_lost: vidPrecisionLost,
        cjk_sites: cjkList,
      });
    }

    // ---- 归属解析：从**数据库**读全部 BD 登记行（分片跑完后内存里只有最后一片）----
    const PAGE = 1000;
    const bdRows: Array<{
      staff_name: string;
      country: string;
      nickname_raw: string;
      nickname_norm: string;
      handle_raw: string;
      handle_norm: string;
      register_date: string | null;
      sample_date: string | null;
      source_sheet: string;
      row_number: number | null;
      follower_count: number | null;
    }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("creator_registry")
        .select("staff_name, country, nickname_raw, nickname_norm, handle_raw, handle_norm, register_date, sample_date, source_sheet, row_number, follower_count")
        .eq("role", "BD")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`读取登记表失败：${error.message}`);
      const page = data ?? [];
      bdRows.push(...(page as typeof bdRows));
      if (page.length < PAGE) break;
    }

    // ---- 保护期归属解析（仅 BD 行；NICKNAME / HANDLE 各一遍）----
    const nickGroups = new Map<string, RegistryEntry[]>();
    const handleGroups = new Map<string, RegistryEntry[]>();
    for (const r of bdRows) {
      const date = r.register_date ?? r.sample_date;
      if (r.nickname_norm) {
        const groupKey = identityKey(r.country, r.nickname_norm);
        const arr = nickGroups.get(groupKey) ?? [];
        arr.push({ matchKey: r.nickname_norm, staff: r.staff_name, date, sheet: r.source_sheet, rowNumber: r.row_number, display: r.nickname_raw, country: r.country });
        nickGroups.set(groupKey, arr);
      }
      if (r.handle_norm) {
        const groupKey = identityKey(r.country, r.handle_norm);
        const arr = handleGroups.get(groupKey) ?? [];
        arr.push({ matchKey: r.handle_norm, staff: r.staff_name, date, sheet: r.source_sheet, rowNumber: r.row_number, display: r.handle_raw, country: r.country });
        handleGroups.set(groupKey, arr);
      }
    }
    // 昵称 → 已知粉丝量（同名多行取最大值，缺失为 null）
    const followerByNick = new Map<string, number>();
    for (const r of bdRows) {
      if (r.follower_count == null || !r.nickname_norm) continue;
      const k = identityKey(r.country, r.nickname_norm);
      followerByNick.set(k, Math.max(followerByNick.get(k) ?? 0, r.follower_count));
    }

    const nickRes = resolveOwnership(nickGroups, "NICKNAME");
    const handleRes = resolveOwnership(handleGroups, "HANDLE");

    // 同一字符串同时作为昵称和用户名、归属不同 BD → KEYTYPE_CONFLICT
    const reviews: ReviewItem[] = [...nickRes.reviews, ...handleRes.reviews];
    const nickOwnerByKey = new Map(nickRes.owners.map((o) => [identityKey(o.country, o.matchKey), o]));
    for (const h of handleRes.owners) {
      const n = nickOwnerByKey.get(identityKey(h.country, h.matchKey));
      if (n && n.ownerBd !== h.ownerBd) {
        reviews.push({
          reviewKey: `KEYTYPE:${identityKey(h.country, h.matchKey)}`,
          type: "KEYTYPE_CONFLICT",
          subject: n.displayName || h.displayName,
          detail: { matchKey: h.matchKey, nicknameOwner: n.ownerBd, handleOwner: h.ownerBd },
          defaultResolution: `匹配时昵称归属优先，默认归 ${n.ownerBd}`,
        });
      }
    }

    // ---- 重建 creator_ownership ----
    {
      const { error } = await db.from("creator_ownership").delete().in("key_type", ["NICKNAME", "HANDLE"]);
      if (error) throw new Error(error.message);
    }
    const ownRows = [
      ...nickRes.owners.map((o) => ({
        key_type: "NICKNAME",
        ...ownRow(o),
        follower_count: followerByNick.get(identityKey(o.country, o.matchKey)) ?? null,
      })),
      ...handleRes.owners.map((o) => ({ key_type: "HANDLE", ...ownRow(o) })),
    ];
    for (let i = 0; i < ownRows.length; i += 500) {
      const { error } = await db.from("creator_ownership").insert(ownRows.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }

    // ---- 审查项落库 ----
    await persistRunArtifacts(db, { rows: [], reviews, newAliases: [] });
    const { count: reviewsOpen } = await db
      .from("attribution_review")
      .select("id", { count: "exact", head: true })
      .eq("status", "OPEN");

    return json({
      done: true,
      phase: "RESOLVE",
      processed,
      remaining: [],
      // 归属解析读的是整张表，所以这里报的是全库口径，不是本次写入的片
      registry_rows: bdRows.length,
      registry_vid_rows: writtenVidRows,
      registry_rows_written: writtenRows,
      ownership_keys: ownRows.length,
      reviews_open: reviewsOpen ?? 0,
      missing_sheets: missing,
      vid_precision_lost: vidPrecisionLost,
      follower_rows: followerRows,
      cjk_sites: cjkList,
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("attribution-sync-creators", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function ownRow(o: {
  matchKey: string;
  ownerBd: string;
  country: string;
  displayName: string;
  firstDate: string | null;
  ownerLastDate: string | null;
  transferCount: number;
  evidence: unknown;
}) {
  return {
    match_key: o.matchKey,
    display_name: o.displayName,
    country: o.country,
    owner_bd: o.ownerBd,
    first_register_date: o.firstDate,
    owner_last_register_date: o.ownerLastDate,
    transfer_count: o.transferCount,
    evidence: o.evidence,
    resolved_at: new Date().toISOString(),
  };
}
