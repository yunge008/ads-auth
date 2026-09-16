// GMV 归因 V3 阶段 2：身份层与归属区间的**全量生成**（只生成不使用）。
//
// 【这个函数不改变任何归因数字】。归因引擎（attribution-run / attribution-upload）此刻
// 仍然读 creator_ownership 的单值归属；这里生成的 creator_identity_* 与
// creator_attribution_stages 是给阶段 3 切换用的，先跑出来回答「改完会变多少」。
//
// Body: { action, country?, gmv_months? }
//   · action='build'   全量重建：身份边 → 实体(creator_id) → 别名 → 归属区间，返回统计报告
//   · action='report'  只读：不重建，返回当前身份/区间的统计与「区间 vs 现有单值归属」的差异
//   · country          只跑一个站点（登记表六万行 + 广告明细全跑会吃掉 CPU 配额，站点分片更稳）
//   · gmv_months       GMV MAX 侧回看几个月（默认 6），只影响身份边的昵称覆盖面
//
// 鉴权：管理口令（gmv-attribution-admin tab），与其他归因管理动作一致。
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { normalizeName } from "../_shared/attribution.ts";
import {
  type IdentityEdge,
  type ExistingEntity,
  assignCreatorIds,
  buildIdentityComponents,
  currentIdentityValues,
  edgesFromGmvRows,
  edgesFromRegistry,
  nodeKey,
} from "../_shared/identity.ts";
import {
  type StageHandover,
  type StageManualDecision,
  type StageRegistryRow,
  buildAllStages,
} from "../_shared/stages.ts";

const PAGE = 1000;

/** 分页读全表。每个调用方都必须带 .order(<唯一列>)，否则翻页之间会重复或漏行。 */
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
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

async function insertChunked(db: SupabaseClient, table: string, rows: unknown[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

type RegistryRow = {
  country: string;
  vid: string;
  nickname_norm: string;
  nickname_raw: string;
  handle_norm: string;
  handle_raw: string;
  register_date: string | null;
  sample_date: string | null;
  staff_name: string;
  role: string;
  source_sheet: string;
  row_number: number | null;
};

async function loadRegistry(db: SupabaseClient, country?: string): Promise<RegistryRow[]> {
  return await pageAll<RegistryRow>((f, t) => {
    let q = db
      .from("creator_registry")
      .select("country, vid, nickname_norm, nickname_raw, handle_norm, handle_raw, register_date, sample_date, staff_name, role, source_sheet, row_number")
      .eq("role", "BD");
    if (country) q = q.eq("country", country);
    return q.order("id").range(f, t);
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  try {
    await checkAdminPasscode(req, "gmv-attribution-admin");
    const db = admin();
    const body = (await req.json().catch(() => ({}))) as { action?: string; country?: string; gmv_months?: number };
    const action = body.action ?? "report";
    const country = body.country?.trim() ? body.country.trim().toUpperCase() : undefined;

    // ---------- 只读报告 ----------
    if (action === "report") {
      const counts = async (table: string) => {
        let q = db.from(table).select("id", { count: "exact", head: true });
        if (country) q = q.eq(table === "creator_attribution_stages" ? "country" : "site", country);
        const { count, error } = await q;
        if (error) throw new Error(`${table}: ${error.message}`);
        return count ?? 0;
      };
      const [edges, aliases, stages] = await Promise.all([
        counts("creator_identity_edges"),
        counts("creator_identity_aliases"),
        counts("creator_attribution_stages"),
      ]);
      let diffQ = db
        .from("creator_stage_ownership_diff")
        .select("country, creator_key, display_name, current_owner_bd, stage_owner_bd, stage_type, stage_start_date, diff_kind")
        .neq("diff_kind", "SAME")
        .limit(500);
      if (country) diffQ = diffQ.eq("country", country);
      const { data: diffRows, error: diffErr } = await diffQ;
      if (diffErr) throw new Error(diffErr.message);
      const byKind = new Map<string, number>();
      for (const r of (diffRows ?? []) as Array<{ diff_kind: string }>) {
        byKind.set(r.diff_kind, (byKind.get(r.diff_kind) ?? 0) + 1);
      }
      return json({
        country: country ?? "ALL",
        edges,
        aliases,
        stages,
        diff_by_kind: Object.fromEntries(byKind),
        diff_sample: (diffRows ?? []).slice(0, 100),
        note: "身份表与区间表已生成但尚未被归因引擎使用（阶段 2「只生成不使用」）",
      });
    }

    if (action !== "build") return json({ error: `未知 action: ${action}` }, 400);

    // ---------- 1) 身份边 ----------
    const registry = await loadRegistry(db, country);
    const feishuEdges = edgesFromRegistry(
      registry.map((r) => ({
        country: r.country,
        vid: r.vid ?? "",
        nicknameNorm: r.nickname_norm ?? "",
        handleNorm: r.handle_norm ?? "",
        registerDate: r.register_date,
        sampleDate: r.sample_date,
        staffName: r.staff_name,
      })),
    );
    const gmvMonths = Number.isFinite(body.gmv_months) ? Number(body.gmv_months) : 6;
    const { data: gmvNameRows, error: gmvErr } = await db.rpc("attribution_identity_gmv_names", {
      _months: gmvMonths,
      _country: country ?? null,
    });
    if (gmvErr) throw new Error(`attribution_identity_gmv_names: ${gmvErr.message}`);
    const gmvEdges = edgesFromGmvRows(
      ((gmvNameRows ?? []) as Array<{ country: string; vid: string; account_name: string; month: string }>).map((r) => ({
        country: r.country,
        vid: r.vid,
        accountNameNorm: normalizeName(r.account_name),
        month: r.month,
      })),
    );

    // 人工确认的合并 / 人工否决的错误合并：**事实层，不重建**，只读回来参与计算
    const existingEdges = await pageAll<{
      site: string;
      vid: string;
      feishu_nickname_norm: string;
      feishu_username_norm: string;
      gmv_nickname_norm: string;
      observed_date: string | null;
      source: string;
      status: string;
    }>((f, t) => {
      const q = db
        .from("creator_identity_edges")
        .select("site, vid, feishu_nickname_norm, feishu_username_norm, gmv_nickname_norm, observed_date, source, status");
      return (country ? q.eq("site", country) : q).order("id").range(f, t);
    });
    // 否决键**不含 source**：人判的是「这两个名字不是一个人」，
    // 不该因为同样的连接换个来源（飞书/GMV MAX）又被做回来。
    const rejected = new Set(
      existingEdges
        .filter((e) => e.status === "REJECTED")
        .map((e) => `${e.site}|${e.vid}|${e.feishu_nickname_norm}|${e.feishu_username_norm}|${e.gmv_nickname_norm}`),
    );
    const manualEdges: IdentityEdge[] = existingEdges
      .filter((e) => e.source === "MANUAL")
      .map((e) => ({
        site: e.site,
        vid: e.vid,
        feishuNicknameNorm: e.feishu_nickname_norm,
        feishuUsernameNorm: e.feishu_username_norm,
        gmvNicknameNorm: e.gmv_nickname_norm,
        observedDate: e.observed_date,
        source: "MANUAL",
        status: e.status === "REJECTED" ? "REJECTED" : "ACTIVE",
      }));

    const edges: IdentityEdge[] = [...feishuEdges, ...gmvEdges].map((e) => ({
      ...e,
      // 人工否决过的边，重建后仍然是 REJECTED —— 否则下一次重算又会把错误合并做回来
      status: rejected.has(`${e.site}|${e.vid}|${e.feishuNicknameNorm}|${e.feishuUsernameNorm}|${e.gmvNicknameNorm}`)
        ? "REJECTED"
        : e.status,
    }));
    edges.push(...manualEdges);

    // 边表按 (站点, VID, 来源, 三个名字) upsert：事实层 append-only，不整表删
    const edgeRows = new Map<string, Record<string, unknown>>();
    for (const e of edges) {
      if (e.source === "MANUAL") continue; // 人工边本来就在库里
      const k = `${e.site}|${e.vid}|${e.source}|${e.feishuNicknameNorm}|${e.feishuUsernameNorm}|${e.gmvNicknameNorm}`;
      const prev = edgeRows.get(k);
      if (prev) {
        // 同一条边被多行看到：observed_date 取最早、last_observed_date 取最晚
        const first = prev.observed_date as string | null;
        const last = prev.last_observed_date as string | null;
        if (e.observedDate && (!first || e.observedDate < first)) prev.observed_date = e.observedDate;
        if (e.observedDate && (!last || e.observedDate > last)) prev.last_observed_date = e.observedDate;
        continue;
      }
      edgeRows.set(k, {
        site: e.site,
        vid: e.vid,
        feishu_nickname_norm: e.feishuNicknameNorm,
        feishu_username_norm: e.feishuUsernameNorm,
        gmv_nickname_norm: e.gmvNicknameNorm,
        observed_date: e.observedDate,
        last_observed_date: e.observedDate,
        source: e.source,
        status: e.status,
      });
    }
    const edgeRowsArr = Array.from(edgeRows.values());
    for (let i = 0; i < edgeRowsArr.length; i += 500) {
      const { error } = await db.from("creator_identity_edges").upsert(edgeRowsArr.slice(i, i + 500), {
        onConflict: "site,vid,source,feishu_nickname_norm,feishu_username_norm,gmv_nickname_norm",
        // status 不在这里覆盖：人工标的 REJECTED 必须活下来
        ignoreDuplicates: false,
      });
      if (error) throw new Error(`creator_identity_edges: ${error.message}`);
    }

    // ---------- 2) 连通分量 → creator_id ----------
    const { components, conflicts, unusableVids } = buildIdentityComponents(edges);

    const entityRows = await pageAll<{
      creator_id: string;
      site: string;
      identity_signature: string;
      created_at: string;
      merged_into: string | null;
    }>((f, t) => {
      const q = db.from("creator_entities").select("creator_id, site, identity_signature, created_at, merged_into");
      return (country ? q.eq("site", country) : q).order("creator_id").range(f, t);
    });
    const existingEntities: ExistingEntity[] = entityRows.map((e) => ({
      creatorId: e.creator_id,
      site: e.site,
      signature: e.identity_signature,
      createdAt: e.created_at,
      mergedInto: e.merged_into,
    }));

    const assign = assignCreatorIds(components, existingEntities);
    // 合并：被吞掉的一方保留 creator_id（外部引用仍能解析），只记 merged_into
    for (const m of assign.merges) {
      const { error } = await db
        .from("creator_entities")
        .update({ merged_into: m.mergedInto })
        .eq("creator_id", m.creatorId);
      if (error) throw new Error(`creator_entities merge: ${error.message}`);
    }
    for (const u of assign.signatureUpdates) {
      const { error } = await db
        .from("creator_entities")
        .update({ identity_signature: u.signature })
        .eq("creator_id", u.creatorId);
      if (error) throw new Error(`creator_entities signature: ${error.message}`);
    }
    if (assign.inserts.length) {
      const rows = assign.inserts.map((i) => ({ site: i.site, identity_signature: i.signature }));
      for (let i = 0; i < rows.length; i += 500) {
        const { data, error } = await db.from("creator_entities").insert(rows.slice(i, i + 500)).select("creator_id, identity_signature");
        if (error) throw new Error(`creator_entities insert: ${error.message}`);
        for (const r of (data ?? []) as Array<{ creator_id: string; identity_signature: string }>) {
          assign.bySignature.set(r.identity_signature, r.creator_id);
        }
      }
    }

    // ---------- 3) 别名（派生层，整表重建） ----------
    // 原文显示名：同一个归一化名可能有多种原文写法，取任意一种即可，只用于展示
    const displayByNode = new Map<string, string>();
    for (const r of registry) {
      if (r.nickname_norm) displayByNode.set(nodeKey(r.country, "NICKNAME", r.nickname_norm), r.nickname_raw ?? "");
      if (r.handle_norm) displayByNode.set(nodeKey(r.country, "USERNAME", r.handle_norm), r.handle_raw ?? "");
    }
    {
      let del = db.from("creator_identity_aliases").delete();
      del = country ? del.eq("site", country) : del.neq("site", "\u0000");
      const { error } = await del;
      if (error) throw new Error(`creator_identity_aliases delete: ${error.message}`);
    }
    const aliasRows: unknown[] = [];
    for (const c of components) {
      const creatorId = assign.bySignature.get(c.signature);
      if (!creatorId) continue; // 理论上不会发生：insert 后每个分量都有 ID
      for (const a of c.aliases) {
        aliasRows.push({
          creator_id: creatorId,
          site: a.site,
          identity_type: a.type,
          identity_value: displayByNode.get(nodeKey(a.site, a.type, a.normalizedValue)) ?? a.normalizedValue,
          normalized_value: a.normalizedValue,
          first_seen_date: a.firstSeenDate,
          last_seen_date: a.lastSeenDate,
          source: a.source,
          status: "ACTIVE",
        });
      }
    }
    await insertChunked(db, "creator_identity_aliases", aliasRows);

    // ---------- 4) 归属区间（派生层，整表重建） ----------
    const handoverRows = await pageAll<{ country: string; from_bd: string; to_bd: string; handover_date: string }>(
      (f, t) => {
        const q = db.from("site_handovers").select("country, from_bd, to_bd, handover_date");
        return (country ? q.eq("country", country) : q).order("id").range(f, t);
      },
    );
    const handoversByCountry = new Map<string, StageHandover[]>();
    for (const h of handoverRows) {
      const arr = handoversByCountry.get(h.country) ?? [];
      arr.push({ fromBd: h.from_bd, toBd: h.to_bd, date: h.handover_date });
      handoversByCountry.set(h.country, arr);
    }

    const manualRows = await pageAll<{
      country: string;
      creator_key: string;
      decision: string;
      staff_name: string | null;
      effective_from: string;
      effective_to: string | null;
    }>((f, t) => {
      const q = db
        .from("attribution_manual_decisions")
        .select("country, creator_key, decision, staff_name, effective_from, effective_to")
        .eq("enabled", true);
      return (country ? q.eq("country", country) : q).order("id").range(f, t);
    });
    const manualByCreator = new Map<string, StageManualDecision[]>();
    for (const m of manualRows) {
      const k = `${m.country}\u001f${m.creator_key}`;
      const arr = manualByCreator.get(k) ?? [];
      arr.push({
        decision: m.decision as "ASSIGN" | "EXCLUDE",
        staffName: m.staff_name,
        effectiveFrom: m.effective_from,
        effectiveTo: m.effective_to,
      });
      manualByCreator.set(k, arr);
    }

    // 区间的 creator_key 用**昵称**（与现有 creator_ownership 的 NICKNAME 键同源），
    // 这样阶段 2 的对账视图能逐个达人对上；阶段 3.6 切引擎时再换成 creator_id。
    const stageRows: StageRegistryRow[] = registry
      .filter((r) => r.nickname_norm && r.staff_name)
      .map((r) => ({
        country: r.country,
        creatorKey: r.nickname_norm,
        staff: r.staff_name,
        sampleDate: r.sample_date,
        registerDate: r.register_date,
        sheet: r.source_sheet,
        rowNumber: r.row_number,
      }));
    const { stages, grabs } = buildAllStages({ rows: stageRows, handoversByCountry, manualByCreator });

    // 达人 → creator_id（昵称节点所在的分量）
    const creatorIdByNode = new Map<string, string>();
    for (const c of components) {
      const id = assign.bySignature.get(c.signature);
      if (!id) continue;
      for (const k of c.nodeKeys) creatorIdByNode.set(k, id);
    }

    {
      let del = db.from("creator_attribution_stages").delete();
      del = country ? del.eq("country", country) : del.neq("country", "\u0000");
      const { error } = await del;
      if (error) throw new Error(`creator_attribution_stages delete: ${error.message}`);
    }
    await insertChunked(
      db,
      "creator_attribution_stages",
      stages.map((s) => ({
        country: s.country,
        creator_key: s.creatorKey,
        creator_id: creatorIdByNode.get(nodeKey(s.country, "NICKNAME", s.creatorKey)) ?? null,
        staff_name: s.staffName,
        stage_type: s.stageType,
        start_date: s.startDate,
        end_date: s.endDate,
        evidence: s.evidence,
      })),
    );

    // ---------- 5) 报告 ----------
    const multiNameComponents = components.filter((c) => c.nodeKeys.length > 1);
    // 抽样展示「哪些名字被判成了同一个人」，人先看这批合并对不对再谈切引擎
    const mergeSample = multiNameComponents.slice(0, 50).map((c) => {
      const cur = currentIdentityValues(c.aliases);
      return {
        site: c.site,
        creator_id: assign.bySignature.get(c.signature) ?? null,
        current_nickname: cur.nickname,
        current_username: cur.username,
        names: c.aliases.map((a) => `${a.type === "NICKNAME" ? "昵称" : "用户名"}:${a.normalizedValue}`),
      };
    });
    const gmvOnlyLinked = components.filter(
      (c) =>
        c.nodeKeys.length > 1 &&
        c.aliases.some((a) => a.source === "GMV_MAX") &&
        c.aliases.some((a) => a.source === "FEISHU"),
    );
    const stagesByCreator = new Map<string, number>();
    for (const s of stages) {
      const k = `${s.country}\u001f${s.creatorKey}`;
      stagesByCreator.set(k, (stagesByCreator.get(k) ?? 0) + 1);
    }
    const multiStageCreators = [...stagesByCreator.values()].filter((n) => n > 1).length;

    return json({
      country: country ?? "ALL",
      gmv_months: gmvMonths,
      registry_rows: registry.length,
      edges: edgeRowsArr.length,
      manual_edges: manualEdges.length,
      rejected_edges: rejected.size,
      components: components.length,
      components_multi_name: multiNameComponents.length,
      components_linked_via_gmv_nickname: gmvOnlyLinked.length,
      entities_created: assign.inserts.length,
      entities_merged: assign.merges.length,
      identity_merge_sample: mergeSample,
      identity_conflicts: conflicts.length,
      identity_conflict_sample: conflicts.slice(0, 50),
      unusable_vids: unusableVids.length,
      aliases: aliasRows.length,
      stages: stages.length,
      creators_with_multiple_stages: multiStageCreators,
      protection_grabs: grabs.length,
      protection_grab_sample: grabs.slice(0, 50),
      note:
        "阶段 2「只生成不使用」：归因引擎仍读 creator_ownership，本次生成不改变任何 GMV 数字。" +
        "差异对账查视图 creator_stage_ownership_diff 或 action='report'。",
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("attribution-identity-build", e);
    return json({ error: (e as Error).message }, status);
  }
});
