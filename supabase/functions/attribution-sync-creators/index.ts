// 同步飞书达人登记 3 处数据 → creator_registry，并做保护期归属解析 → creator_ownership。
// 数据源：
//   1. BD 建联表（FEISHU_SPREADSHEET_TOKEN，「建联-姓名」sheets，含离职）
//      A=BD B=发样日期 C=国家 D=用户名 E=昵称 K=SKU N=登记日期 P=VID
//   2. 「授权记录」归档 K3:Q（同表格）：K=BD L=登记日期 M=国家 N=达人名字 O=VID
//   3. 剪辑表（FEISHU_EDITOR_SPREADSHEET_TOKEN）：B=同事 C=日期 D=国家 E=账号 F=SKU G=VID
// Body: {}（无入参，读全部 staff_sheets 含 active=false）
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { cellText, parseDate } from "../_shared/cells.ts";
import {
  type RegistryEntry,
  type ReviewItem,
  identityKey,
  normalizeName,
  resolveOwnership,
} from "../_shared/attribution.ts";
import { persistRunArtifacts } from "../_shared/attribution-report.ts";

const VID_RE = /^7\d{18}$/;
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
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "gmv-attribution-admin");
    const db = admin();

    // 全部人员（含离职 active=false），归因需要覆盖历史数据
    const { data: staffRows, error: staffErr } = await db
      .from("staff_sheets")
      .select("name, sheet_name, active, role");
    if (staffErr) throw new Error(staffErr.message);
    const staff = (staffRows ?? []) as { name: string; sheet_name: string; active: boolean; role: string }[];
    const activeByName = new Map(staff.map((s) => [s.name, !!s.active]));

    const token = await getTenantAccessToken();
    const regRows: RegRow[] = [];
    const missing: string[] = [];
    const processedSheets = new Set<string>();

    // ---- 1) BD 建联表 + 2) 授权记录归档（主表格）----
    const mainToken = getSpreadsheetToken();
    const mainSheets = await listSheets(token, mainToken);
    const mainByName = new Map(mainSheets.map((s) => [s.title, s.sheet_id]));

    for (const t of staff.filter((s) => s.role === "BD")) {
      const sid = mainByName.get(t.sheet_name);
      if (!sid) {
        missing.push(t.sheet_name);
        continue;
      }
      // 17 列 × 250 行 ≈ 4250 cells，低于飞书 ~5000 上限
      const rows = await readRange(token, mainToken, `${sid}!A2:Q`, 250);
      processedSheets.add(t.sheet_name);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const handleRaw = cellText(r[3]);
        const nicknameRaw = cellText(r[4]);
        const vidRaw = cellText(r[15]);
        const vid = VID_RE.test(vidRaw) ? vidRaw : "";
        const handleNorm = normalizeName(handleRaw);
        const nicknameNorm = normalizeName(nicknameRaw);
        if (!handleNorm && !nicknameNorm && !vid) continue;
        regRows.push({
          source: "JIANLIAN",
          source_sheet: t.sheet_name,
          row_number: i + 2,
          role: "BD",
          staff_name: t.name,
          staff_active: !!t.active,
          register_date: parseDate(r[13]),
          sample_date: parseDate(r[1]),
          country: cellText(r[2]),
          handle_raw: handleRaw,
          handle_norm: handleNorm,
          nickname_raw: nicknameRaw,
          nickname_norm: nicknameNorm,
          vid,
          registered_sku: cellText(r[10]) || null,
        });
      }
    }

    const logSid = mainByName.get(LOG_SHEET_TITLE);
    if (logSid) {
      const rows = await readRange(token, mainToken, `${logSid}!K3:Q`);
      processedSheets.add(LOG_SHEET_TITLE);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const bd = cellText(r[0]) || "原数据";
        const nicknameRaw = cellText(r[3]);
        const vidRaw = cellText(r[4]);
        const vid = VID_RE.test(vidRaw) ? vidRaw : "";
        const nicknameNorm = normalizeName(nicknameRaw);
        if (!nicknameNorm && !vid) continue;
        regRows.push({
          source: "ARCHIVE",
          source_sheet: LOG_SHEET_TITLE,
          row_number: i + 3,
          role: "BD",
          staff_name: bd,
          staff_active: activeByName.get(bd) ?? false,
          register_date: parseDate(r[1]),
          sample_date: null,
          country: cellText(r[2]),
          handle_raw: "",
          handle_norm: "",
          nickname_raw: nicknameRaw,
          nickname_norm: nicknameNorm,
          vid,
          registered_sku: cellText(r[6]) || null,
        });
      }
    } else {
      missing.push(LOG_SHEET_TITLE);
    }

    // ---- 3) 剪辑表 ----
    const editors = staff.filter((s) => s.role === "EDITOR");
    if (editors.length) {
      const edToken = getSpreadsheetToken("FEISHU_EDITOR_SPREADSHEET_TOKEN");
      const edSheets = await listSheets(token, edToken);
      const edByName = new Map(edSheets.map((s) => [s.title, s.sheet_id]));
      for (const t of editors) {
        const sid = edByName.get(t.sheet_name);
        if (!sid) {
          missing.push(t.sheet_name);
          continue;
        }
        const rows = await readRange(token, edToken, `${sid}!A2:H`);
        processedSheets.add(t.sheet_name);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] ?? [];
          const who = cellText(r[1]);
          if (!who || who !== t.name) continue; // 与 feishu-read-editors 同规则：B 列同事须等于表名对应姓名
          const vidRaw = cellText(r[6]);
          if (!VID_RE.test(vidRaw)) continue;
          const acctRaw = cellText(r[4]);
          regRows.push({
            source: "EDITOR",
            source_sheet: t.sheet_name,
            row_number: i + 2,
            role: "EDITOR",
            staff_name: t.name,
            staff_active: !!t.active,
            register_date: parseDate(r[2]),
            sample_date: null,
            country: cellText(r[3]),
            handle_raw: "",
            handle_norm: "",
            nickname_raw: acctRaw,
            nickname_norm: normalizeName(acctRaw),
            vid: vidRaw,
            registered_sku: cellText(r[5]) || null,
          });
        }
      }
    }

    // ---- 重建 creator_registry（按 source_sheet 全量重建）----
    const sheetsArr = Array.from(processedSheets);
    for (let i = 0; i < sheetsArr.length; i += 50) {
      const { error } = await db
        .from("creator_registry")
        .delete()
        .in("source_sheet", sheetsArr.slice(i, i + 50));
      if (error) throw new Error(error.message);
    }
    for (let i = 0; i < regRows.length; i += 500) {
      const { error } = await db.from("creator_registry").insert(regRows.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }

    // ---- 保护期归属解析（仅 BD 行；NICKNAME / HANDLE 各一遍）----
    const bdRows = regRows.filter((r) => r.role === "BD");
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
      ...nickRes.owners.map((o) => ({ key_type: "NICKNAME", ...ownRow(o) })),
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

    return new Response(
      JSON.stringify({
        registry_rows: regRows.length,
        ownership_keys: ownRows.length,
        reviews_open: reviewsOpen ?? 0,
        missing_sheets: missing,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
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
