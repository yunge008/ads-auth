// 归因体系与飞书的双向同步（5 个 sheet 均在 FEISHU_SPREADSHEET_TOKEN 主表格内，需人工先建）：
//   「归因进度」 A回写时间 B月份 C姓名/桶 D角色 E归因GMV F消耗 G订单 H目标USD I进度% J VID匹配GMV K 昵称/别名GMV L 未归因参考 M 备注
//   「归因审查」 A审查ID B类型 C主体 D候选BD E默认处理 F证据摘要 G首次发现 H最近发现 I状态 J人工判定BD(人工填) K人工备注(人工填) L采纳标记(系统)
//   「GMV目标」  A月份 B姓名 C角色(BD/剪辑) D目标USD E备注 —— 人工维护，系统只读
//   「站点交接」 A国家 B原BD C新BD D交接日期 E备注 —— 人工维护，系统只读
//   「达人归因表」A类型 B名称 C归一化键 D国家 E当前BD F最后登记日期 G转移/证据 H交接提示 —— 系统覆盖写
// Body: { action: 'write-progress'|'write-reviews'|'read-judgments'|'sync-targets'|'sync-handovers'|'write-ownership'|'list-reviews', month? }
//   list-reviews 仅读数据库（前端审查面板用），不访问飞书。
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
  writeValues,
} from "../_shared/feishu.ts";
import { admin, verifyPasscode } from "../_shared/auth.ts";
import { cellText, parseDate } from "../_shared/cells.ts";
import { normalizeName, splitIdentityKey } from "../_shared/attribution.ts";
import { buildMonthlyReport } from "../_shared/attribution-report.ts";

const SHEET_PROGRESS = "\u7ee9\u6548\u7edf\u8ba1\u8bb0\u5f55";
const SHEET_REVIEWS = "\u5f52\u56e0\u5ba1\u67e5";
const SHEET_CONFIG = "\u7ee9\u6548\u914d\u7f6e\u8868";
const SHEET_OWNERSHIP = "\u5f52\u56e0\u8bb0\u5f55";

const TYPE_LABELS: Record<string, string> = {
  VID_DUAL_SOURCE: "VID双登记",
  ALIAS_VOTE_CONFLICT: "别名冲突",
  PROTECTION_GRAB: "保护期抢注",
  KEYTYPE_CONFLICT: "昵称/用户名冲突",
  HANDOVER_BOUNDARY: "交接边界提示",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nowCn(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function normMonth(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.年]?(\d{1,2})月?$/);
  if (!m) {
    m = s.match(/^(\d{4})(\d{2})$/);
  }
  if (!m) return null;
  const mo = parseInt(m[2], 10);
  if (mo < 1 || mo > 12) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}`;
}

async function nextRow(token: string, ss: string, sid: string): Promise<number> {
  const col = await readRange(token, ss, `${sid}!A1:A`);
  return col.length + 1;
}

async function writeRowsAt(
  token: string,
  ss: string,
  sid: string,
  startRow: number,
  endColLetter: string,
  rows: unknown[][],
  chunk = 300,
) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const from = startRow + i;
    const to = from + part.length - 1;
    await writeValues(token, ss, [{ range: `${sid}!A${from}:${endColLetter}${to}`, values: part }]);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const account = await verifyPasscode(req, "gmv-attribution-admin");
    const body = (await req.json()) as { action?: string; month?: string };
    const action = (body.action ?? "").trim();
    const db = admin();

    // 仅查库的 action 不访问飞书
    if (action === "list-reviews") {
      const { data, error } = await db
        .from("attribution_review")
        .select("review_key, review_type, subject, detail, default_resolution, manual_bd, manual_note, status, first_seen_at, last_seen_at")
        .order("status", { ascending: true }) // OPEN 在前（字母序 OPEN < RESOLVED）
        .order("last_seen_at", { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      return json({ reviews: data ?? [] });
    }

    const token = await getTenantAccessToken();
    const ss = getSpreadsheetToken();
    const sheets = await listSheets(token, ss);
    const byName = new Map(sheets.map((s) => [s.title, s.sheet_id]));
    const sheetId = (title: string) => {
      const sid = byName.get(title);
      if (!sid) throw new Error(`飞书表格缺少 sheet「${title}」，请先手动创建并填好表头`);
      return sid;
    };

    // ---------- 归因进度快照 ----------
    if (action === "write-progress") {
      const month = (body.month ?? "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 必填（YYYY-MM）");
      const sid = sheetId(SHEET_PROGRESS);
      const { report } = await buildMonthlyReport(db, month);
      const ts = nowCn();
      const rows: unknown[][] = [];
      for (const s of report.staff) {
        const vidGmv = s.by_match.VID ?? 0;
        const nickGmv = (s.by_match.REGISTRY ?? 0) + (s.by_match.ALIAS_VID ?? 0) + (s.by_match.ALIAS_MANUAL ?? 0);
        for (const cell of s.by_country) {
          rows.push([
            ts, month, cell.country, s.staff_name, s.role === "BD" ? "BD" : "\u526a\u8f91",
            round2(cell.gmv), round2(cell.cost), cell.orders,
            s.target_usd ?? "", s.progress != null ? `${(s.progress * 100).toFixed(1)}%` : "",
            round2(vidGmv), round2(nickGmv), 0, 0, "", "", "", "", s.active ? "" : "\u5df2\u79bb\u804c",
          ]);
        }
      }
      rows.push([ts, month, "", "\u5546\u54c1\u5361", "-", round2(report.product_card.gmv), round2(report.product_card.cost), report.product_card.orders, "", "", "", "", round2(report.product_card.gmv), "", "", "", "", "", ""]);
      rows.push([ts, month, "", "\u672a\u5f52\u56e0", "-", round2(report.unmatched.gmv), round2(report.unmatched.cost), report.unmatched.orders, "", "", "", "", "", round2(report.unmatched.gmv), "", "", "", "", ""]);
      const start = await nextRow(token, ss, sid);
      await writeRowsAt(token, ss, sid, start, "S", rows);
      return json({ appended: rows.length, month });
    }

    // ---------- 审查项追加 ----------
    if (action === "write-reviews") {
      const sid = sheetId(SHEET_REVIEWS);
      const existing = await readRange(token, ss, `${sid}!A2:A`);
      const seen = new Set(existing.map((r) => cellText((r ?? [])[0])).filter(Boolean));

      const open: Array<{
        review_key: string;
        review_type: string;
        subject: string;
        detail: unknown;
        default_resolution: string | null;
        first_seen_at: string;
        last_seen_at: string;
      }> = [];
      {
        let from = 0;
        for (;;) {
          const { data, error } = await db
            .from("attribution_review")
            .select("review_key, review_type, subject, detail, default_resolution, first_seen_at, last_seen_at")
            .eq("status", "OPEN")
            .range(from, from + 999);
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as typeof open;
          open.push(...rows);
          if (rows.length < 1000) break;
          from += 1000;
        }
      }
      const fresh = open.filter((r) => !seen.has(r.review_key));
      const rows: unknown[][] = fresh.map((r) => {
        const d = (r.detail ?? {}) as Record<string, unknown>;
        let candidates = "";
        if (Array.isArray(d.candidates)) {
          candidates = (d.candidates as Array<{ staff?: string; role?: string }>).map((c) => `${c.staff}(${c.role})`).join(" / ");
        } else if (Array.isArray(d.votes)) {
          candidates = (d.votes as Array<{ bd?: string; count?: number }>).map((v) => `${v.bd}×${v.count}`).join(" / ");
        } else if (Array.isArray(d.grabs)) {
          const owner = (d.owner as string) ?? "";
          candidates = [owner, ...(d.grabs as Array<{ bd?: string }>).map((g) => g.bd ?? "")].filter(Boolean).join(" / ");
        } else if (d.nicknameOwner || d.handleOwner) {
          candidates = [d.nicknameOwner, d.handleOwner].filter(Boolean).join(" / ");
        } else if (d.vidEvidence || d.registryOwner) {
          const ev = d.vidEvidence as { bd?: string } | undefined;
          candidates = [ev?.bd, d.registryOwner].filter(Boolean).join(" / ");
        }
        return [
          r.review_key,
          TYPE_LABELS[r.review_type] ?? r.review_type,
          r.subject,
          candidates,
          r.default_resolution ?? "",
          JSON.stringify(r.detail ?? {}).slice(0, 480),
          (r.first_seen_at ?? "").slice(0, 10),
          (r.last_seen_at ?? "").slice(0, 10),
          "待处理",
          "",
          "",
          "",
        ];
      });
      if (rows.length) {
        const start = existing.length + 2;
        await writeRowsAt(token, ss, sid, start, "I", rows);
      }
      return json({ appended: rows.length, open_total: open.length });
    }

    // ---------- 读回人工判定 ----------
    if (action === "read-judgments") {
      const sid = sheetId(SHEET_REVIEWS);
      const rows = await readRange(token, ss, `${sid}!A2:I`, 400);
      const { data: staffRows } = await db.from("staff_sheets").select("name");
      const staffNames = new Set(((staffRows ?? []) as { name: string }[]).map((r) => r.name));

      type Judgment = { rowIdx: number; key: string; bd: string; note: string };
      const judgments: Judgment[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const key = cellText(r[0]);
        const bd = cellText(r[6]); // G ??????
        if (!key || !bd) continue;
        judgments.push({ rowIdx: i + 2, key, bd, note: cellText(r[7]) });
      }
      if (!judgments.length) return json({ applied: 0, warnings: [] });

      // 拉取对应审查项
      const reviewByKey = new Map<string, { review_key: string; review_type: string; subject: string }>();
      const keys = judgments.map((j) => j.key);
      for (let i = 0; i < keys.length; i += 200) {
        const { data, error } = await db
          .from("attribution_review")
          .select("review_key, review_type, subject")
          .in("review_key", keys.slice(i, i + 200));
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as Array<{ review_key: string; review_type: string; subject: string }>) {
          reviewByKey.set(r.review_key, r);
        }
      }

      const warnings: string[] = [];
      let applied = 0;
      const adopted: number[] = [];
      for (const j of judgments) {
        const review = reviewByKey.get(j.key);
        if (!review) {
          warnings.push(`第 ${j.rowIdx} 行：审查ID ${j.key} 在数据库中不存在，已跳过`);
          continue;
        }
        const ignore = j.bd === "忽略" || j.bd === "不处理";
        if (!ignore && !staffNames.has(j.bd)) {
          warnings.push(`第 ${j.rowIdx} 行：人工判定「${j.bd}」不在人员表中（仍已生效，请确认姓名拼写）`);
        }
        // 昵称类判定 → 人工别名（优先级最高，永不被自动覆盖）
        const nicknameTypes = ["ALIAS_VOTE_CONFLICT", "PROTECTION_GRAB", "KEYTYPE_CONFLICT"];
        if (!ignore && nicknameTypes.includes(review.review_type)) {
          const aliasNorm = normalizeName(review.subject);
          const scoped = review.review_key.startsWith("ALIAS:") ? review.review_key.slice("ALIAS:".length) : "";
          const { country } = splitIdentityKey(scoped);
          if (aliasNorm && country) {
            const { error } = await db.from("creator_alias").upsert(
              {
                alias_norm: aliasNorm,
                alias_display: review.subject,
                country,
                bd_name: j.bd,
                source: "MANUAL",
                decided_by: `feishu:${account.name}`,
                evidence: { review_key: j.key, note: j.note },
              },
              { onConflict: "country,alias_norm,source" },
            );
            if (error) throw new Error(error.message);
          }
        }
        const { error } = await db
          .from("attribution_review")
          .update({ manual_bd: ignore ? null : j.bd, manual_note: j.note || null, status: "RESOLVED" })
          .eq("review_key", j.key);
        if (error) throw new Error(error.message);
        applied++;
        adopted.push(j.rowIdx);
      }

      // 回写 L=已采纳
      if (adopted.length) {
        const ranges = adopted.map((rowIdx) => ({ range: `${sid}!L${rowIdx}:L${rowIdx}`, values: [["已采纳"]] }));
        for (let i = 0; i < ranges.length; i += 100) {
          await writeValues(token, ss, ranges.slice(i, i + 100));
        }
      }
      return json({ applied, warnings });
    }

    // ---------- 目标同步 ----------
    if (action === "sync-targets") {
      const sid = sheetId(SHEET_CONFIG);
      const rows = await readRange(token, ss, `${sid}!A2:F`);
      const payload: Array<{ month: string; staff_name: string; role: string; target_usd: number; material_target: number; sites: string[]; target_group_id: string; note: string | null }> = [];
      const skipped: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const monthRaw = cellText(r[0]);
        const name = cellText(r[1]);
        const roleRaw = cellText(r[2]);
        const target = Number(cellText(r[3]).replace(/,/g, ""));
        if (!monthRaw && !name) continue;
        const month = normMonth(monthRaw);
        if (!month || !name || !isFinite(target)) {
          skipped.push(`第 ${i + 2} 行（${monthRaw}/${name}）`);
          continue;
        }
        const role = roleRaw.includes("剪") || roleRaw.toUpperCase().includes("EDITOR") ? "EDITOR" : "BD";
        payload.push({ month, staff_name: name, role, target_usd: target, note: cellText(r[4]) || null });
      }
      // 同键去重（末条胜出）
      const dedup = new Map(payload.map((p) => [`${p.month}|${p.staff_name}|${p.role}|${p.target_group_id}`, p]));
      const finalRows = Array.from(dedup.values());
      for (let i = 0; i < finalRows.length; i += 500) {
        const { error } = await db.from("gmv_targets").upsert(finalRows.slice(i, i + 500), { onConflict: "month,staff_name,role,target_group_id" });
        if (error) throw new Error(error.message);
      }
      return json({ upserted: finalRows.length, skipped });
    }

    // ---------- 站点交接同步 ----------
    if (action === "sync-handovers") {
      const sid = sheetId(SHEET_CONFIG);
      const rows = await readRange(token, ss, `${sid}!H2:L`);
      const payload: Array<{ country: string; from_bd: string; to_bd: string; handover_date: string; note: string | null }> = [];
      const skipped: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const country = cellText(r[0]);
        const fromBd = cellText(r[1]);
        const toBd = cellText(r[2]);
        const date = parseDate(r[3]);
        if (!country && !fromBd && !toBd) continue;
        if (!country || !fromBd || !toBd || !date) {
          skipped.push(`第 ${i + 2} 行（${country}/${fromBd}→${toBd}/${cellText(r[3])}）`);
          continue;
        }
        payload.push({ country, from_bd: fromBd, to_bd: toBd, handover_date: date, note: cellText(r[4]) || null });
      }
      const dedup = new Map(payload.map((p) => [`${p.country}|${p.handover_date}|${p.from_bd}|${p.to_bd}`, p]));
      const finalRows = Array.from(dedup.values());
      // 全量重建
      {
        const { error } = await db.from("site_handovers").delete().gte("handover_date", "1900-01-01");
        if (error) throw new Error(error.message);
      }
      if (finalRows.length) {
        const { error } = await db.from("site_handovers").insert(finalRows);
        if (error) throw new Error(error.message);
      }
      return json({ synced: finalRows.length, skipped });
    }

    // ---------- 达人归因表镜像（覆盖写） ----------
    if (action === "write-ownership") {
      const sid = sheetId(SHEET_OWNERSHIP);
      const [ownRows, aliasRows, hRows] = await Promise.all([
        pageAll<{ key_type: string; match_key: string; display_name: string | null; country: string; owner_bd: string; owner_last_register_date: string | null; transfer_count: number }>(
          (f, t) => db.from("creator_ownership").select("key_type, match_key, display_name, country, owner_bd, owner_last_register_date, transfer_count").range(f, t),
        ),
        pageAll<{ alias_norm: string; alias_display: string | null; country: string; bd_name: string; source: string; evidence_vids: number }>(
          (f, t) => db.from("creator_alias").select("alias_norm, alias_display, country, bd_name, source, evidence_vids").range(f, t),
        ),
        pageAll<{ country: string; from_bd: string; to_bd: string; handover_date: string }>(
          (f, t) => db.from("site_handovers").select("country, from_bd, to_bd, handover_date").range(f, t),
        ),
      ]);
      const handoverNote = (country: string, bd: string) =>
        hRows
          .filter((h) => h.country === country && (h.from_bd === bd || h.to_bd === bd))
          .map((h) => `${h.handover_date} ${h.from_bd}→${h.to_bd}（发布在此日前归${h.from_bd}，之后归${h.to_bd}）`)
          .join(" | ");

      const rows: unknown[][] = [];
      for (const o of ownRows) {
        rows.push([
          o.key_type === "NICKNAME" ? "昵称" : "用户名",
          o.display_name ?? o.match_key,
          o.match_key,
          o.country,
          o.owner_bd,
          o.owner_last_register_date ?? "",
          o.transfer_count > 0 ? `转移${o.transfer_count}次` : "",
          handoverNote(o.country, o.owner_bd),
        ]);
      }
      for (const a of aliasRows) {
        rows.push([
          a.source === "MANUAL" ? "别名-人工" : "别名-推断",
          a.alias_display ?? a.alias_norm,
          a.alias_norm,
          a.country,
          a.bd_name,
          "",
          a.source === "MANUAL" ? "人工判定" : `证据VID×${a.evidence_vids}`,
          handoverNote(a.country, a.bd_name),
        ]);
      }
      rows.sort((x, y) => String(x[4]).localeCompare(String(y[4])) || String(x[1]).localeCompare(String(y[1])));

      await writeRowsAt(token, ss, sid, 2, "J", rows);
      // 清掉上次残留的多余行
      const old = await readRange(token, ss, `${sid}!A2:A`);
      const leftover = old.length - rows.length;
      if (leftover > 0) {
        const blanks = Array.from({ length: leftover }, () => ["", "", "", "", "", "", "", "", "", ""]);
        await writeRowsAt(token, ss, sid, 2 + rows.length, "J", blanks);
      }
      return json({ rows: rows.length });
    }

    throw new Error(`未知 action: ${action}`);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("attribution-feishu", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
