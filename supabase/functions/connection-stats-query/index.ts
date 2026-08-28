// Aggregate query for the "发样及素材统计" tab, reading connection_material_registry
// (populated by feishu-read-connection-stats). Read-only: no Feishu access here at all.
//
// Body: {
//   start_date, end_date,
//   countries?: string[], staff_names?: string[],
//   skus?: string[],   // SKU 搜索：数字整段匹配（"333"命中"333-A"/"AR333"/"333+311"，不命中"3331"/"AR3331"）
//   group_country?: boolean, group_sku?: boolean,   // 回收明细表分组维度，两者独立勾选、都勾则按 国家/SKU 合并分组
// }
//
// 口径（对齐前端确认过的方案）：
// - "发样记录" 去重 key = (handle, country, sku)，用于 BD 发样数量 / 国家占比"发样达人"
// - BD 回收有效日期 = register_date（N 列，视频登记日期），不用 post_date（O 列，发布日期）
// - EDITOR 回收有效日期 = post_date（C 列，语义即发布日期）
// - 回收素材 = vid 去重计数（BD、EDITOR 分别计数，不合并去重）
// - 只看 VID 是否为 7 开头 19 位数字，不校验授权码
// - 两个饼图（国家占比 / 粉丝分层）只统计 BD
// - 粉丝分层：每个达人按"自己所在国家"的门槛表定档（MX 用 MX 门槛，其余国家统一用"其他地区"门槛），
//   然后把各国家算出来的同一档人数相加，得到跨国家合并后的 5 档饼图 —— 和当前筛选/下钻的国家无关
// - BD 日均回收素材 / 剪辑日均产出 都用等效工作日（周一至周五各 1 天、周六 0.5 天、周日 0 天）折算
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

type Reg = {
  source_type: "BD" | "EDITOR";
  staff_name: string;
  country: string;
  handle: string;
  sku: string | null;
  fan_count: number | null;
  sample_date: string | null;
  register_date: string | null;
  post_date: string | null;
  vid: string;
};

const BAND_MX = { 大: 300, 中: 100, 中小: 30, 小: 5 };
const BAND_OTHER = { 大: 100, 中: 50, 中小: 10, 小: 3 };
const TIERS = ["大", "中", "中小", "小", "特小"] as const;
type Tier = (typeof TIERS)[number];

function tierOf(country: string, fanK: number | null): Tier {
  const v = fanK ?? 0;
  const b = country === "MX" ? BAND_MX : BAND_OTHER;
  if (v >= b.大) return "大";
  if (v >= b.中) return "中";
  if (v >= b.中小) return "中小";
  if (v >= b.小) return "小";
  return "特小";
}

function inRange(d: string | null, start: string, end: string): boolean {
  return !!d && d >= start && d <= end;
}

function equivalentWorkdays(start: string, end: string): number {
  let total = 0;
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) return 0;
  for (let d = s; d <= e; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    if (dow === 0) continue;
    total += dow === 6 ? 0.5 : 1;
  }
  return total;
}

function safeDiv(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

// SKU search matches whole numeric tokens only: query "333" matches "333-A", "AR333",
// "333+311" (contains a maximal digit run equal to "333") but NOT "3331", "3331-A",
// "AR3331" (their digit run is "3331", not "333") — never a plain substring match.
function skuDigitTokens(s: string): string[] {
  return s.match(/\d+/g) ?? [];
}
function skuMatchesAny(sku: string, queryTokens: string[]): boolean {
  const tokens = skuDigitTokens(sku);
  return queryTokens.some((q) => tokens.includes(q));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "connection-stats");
    const body = (await req.json()) as {
      start_date: string;
      end_date: string;
      countries?: string[];
      staff_names?: string[];
      skus?: string[];
      group_country?: boolean;
      group_sku?: boolean;
      include_meta?: boolean;
    };
    if (!body.start_date || !body.end_date) throw new Error("start_date / end_date 必填");
    const groupCountry = !!body.group_country;
    const groupSku = !!body.group_sku;
    // Meta (staff dropdown + full country list) rarely changes and is expensive to scan
    // (full-table pagination) — the frontend only asks for it once per page visit, not on
    // every filter change, to keep filter clicks fast.
    const includeMeta = body.include_meta !== false;
    const db = admin();

    const fetchStaffList = async () => {
      const { data: staffRows, error: staffErr } = await db
        .from("staff_sheets")
        .select("name, role")
        .eq("active", true)
        .in("role", ["BD", "EDITOR"]);
      if (staffErr) throw new Error(staffErr.message);
      return {
        bd: (staffRows ?? []).filter((s) => s.role === "BD").map((s) => s.name as string),
        editor: (staffRows ?? []).filter((s) => s.role === "EDITOR").map((s) => s.name as string),
      };
    };

    const fetchCountryList = async () => {
      const countrySet = new Set<string>();
      const PAGE = 1000;
      let from = 0;
      for (;;) {
        const { data, error } = await db
          .from("connection_material_registry")
          .select("country")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as { country: string }[];
        for (const r of rows) if (r.country) countrySet.add(r.country);
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      return Array.from(countrySet).sort();
    };

    const fetchMainRows = async () => {
      const out: (Reg & { synced_at: string })[] = [];
      const PAGE = 1000;
      let from = 0;
      for (;;) {
        let q = db
          .from("connection_material_registry")
          .select(
            "source_type, staff_name, country, handle, sku, fan_count, sample_date, register_date, post_date, vid, synced_at",
          );
        if (body.countries?.length) q = q.in("country", body.countries);
        if (body.staff_names?.length) q = q.in("staff_name", body.staff_names);
        const { data, error } = await q.range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as (Reg & { synced_at: string })[];
        out.push(...rows);
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      return out;
    };

    const [mainRows, staffList, countryList] = await Promise.all([
      fetchMainRows(),
      includeMeta ? fetchStaffList() : Promise.resolve(null),
      includeMeta ? fetchCountryList() : Promise.resolve(null),
    ]);

    const skuQueryTokens = (body.skus ?? []).map((s) => s.trim()).filter(Boolean);
    let lastSyncedAt: string | null = null;
    for (const r of mainRows) {
      if (!lastSyncedAt || r.synced_at > lastSyncedAt) lastSyncedAt = r.synced_at;
    }
    const regRows: Reg[] = skuQueryTokens.length
      ? mainRows.filter((r) => r.sku && skuMatchesAny(r.sku, skuQueryTokens))
      : mainRows;

    const bdRows = regRows.filter((r) => r.source_type === "BD");
    const editorRows = regRows.filter((r) => r.source_type === "EDITOR");
    const { start_date: start, end_date: end } = body;

    // ---- 发样记录（三元组 handle|country|sku 去重）----
    type SendRec = { key: string; staff: string; country: string; sku: string; handle: string; fan: number | null; date: string };
    const sendMap = new Map<string, SendRec>();
    for (const r of bdRows) {
      if (!inRange(r.sample_date, start, end)) continue;
      const sku = r.sku ?? "";
      const key = `${r.handle}|${r.country}|${sku}`;
      if (!sendMap.has(key)) {
        sendMap.set(key, { key, staff: r.staff_name, country: r.country, sku, handle: r.handle, fan: r.fan_count, date: r.sample_date! });
      }
    }
    const sendEvents = Array.from(sendMap.values());

    // ---- BD 回收（vid 去重，有效日期 = register_date）----
    type RecRec = { vid: string; staff: string; country: string; sku: string; handle: string; fan: number | null; date: string };
    const bdRecMap = new Map<string, RecRec>();
    for (const r of bdRows) {
      if (!r.vid || !inRange(r.register_date, start, end)) continue;
      if (!bdRecMap.has(r.vid)) {
        bdRecMap.set(r.vid, { vid: r.vid, staff: r.staff_name, country: r.country, sku: r.sku ?? "", handle: r.handle, fan: r.fan_count, date: r.register_date! });
      }
    }
    const bdRecEvents = Array.from(bdRecMap.values());

    // ---- EDITOR 回收（vid 去重，有效日期 = post_date）----
    type EdRec = { vid: string; staff: string; country: string; sku: string; date: string };
    const edRecMap = new Map<string, EdRec>();
    for (const r of editorRows) {
      if (!r.vid || !inRange(r.post_date, start, end)) continue;
      if (!edRecMap.has(r.vid)) {
        edRecMap.set(r.vid, { vid: r.vid, staff: r.staff_name, country: r.country, sku: r.sku ?? "", date: r.post_date! });
      }
    }
    const edRecEvents = Array.from(edRecMap.values());

    const equivDays = equivalentWorkdays(start, end);

    // ---- KPI ----
    const bdSampleTotal = sendEvents.length;
    const bdRecoverTotal = bdRecEvents.length;
    const editorOutputTotal = edRecEvents.length;
    const summary = {
      bd_sample_total: bdSampleTotal,
      bd_recover_total: bdRecoverTotal,
      bd_recover_rate: safeDiv(bdRecoverTotal, bdSampleTotal),
      bd_daily_avg_recover: equivDays > 0 ? bdRecoverTotal / equivDays : null,
      editor_output_total: editorOutputTotal,
      editor_daily_avg_output: equivDays > 0 ? editorOutputTotal / equivDays : null,
      equivalent_days: Math.round(equivDays * 10) / 10,
    };

    // ---- 回收明细表：按 人员[/国家][/SKU] 分组，国家/SKU 两个维度独立勾选 ----
    type GroupAgg = { staff: string; role: "BD" | "EDITOR"; country: string; sku: string; sampleKeys: Set<string>; recVids: Set<string> };
    const groups = new Map<string, GroupAgg>();
    const groupKey = (staff: string, role: "BD" | "EDITOR", country: string, sku: string) =>
      `${role}|${staff}${groupCountry ? `|${country}` : ""}${groupSku ? `|${sku}` : ""}`;
    const getGroup = (staff: string, role: "BD" | "EDITOR", country: string, sku: string) => {
      const k = groupKey(staff, role, country, sku);
      let g = groups.get(k);
      if (!g) { g = { staff, role, country: groupCountry ? country : "", sku: groupSku ? sku : "", sampleKeys: new Set(), recVids: new Set() }; groups.set(k, g); }
      return g;
    };
    for (const s of sendEvents) getGroup(s.staff, "BD", s.country, s.sku).sampleKeys.add(s.key);
    for (const r of bdRecEvents) getGroup(r.staff, "BD", r.country, r.sku).recVids.add(r.vid);
    for (const r of edRecEvents) getGroup(r.staff, "EDITOR", r.country, r.sku).recVids.add(r.vid);

    const grouped_rows = Array.from(groups.values())
      .map((g) => {
        const samples = g.role === "BD" ? g.sampleKeys.size : null;
        const recovered = g.recVids.size;
        return {
          staff_name: g.staff, role: g.role, country: g.country, sku: g.sku,
          samples, recovered,
          rate: g.role === "BD" ? safeDiv(recovered, samples ?? 0) : null,
        };
      })
      .sort((a, b) => (b.recovered - a.recovered) || a.staff_name.localeCompare(b.staff_name, "zh"));

    // ---- 国家占比（BD only）----
    const countryPieFrom = (items: { country: string }[], keyer: (x: any) => string) => {
      const byCountry = new Map<string, Set<string>>();
      for (const it of items as any[]) {
        const set = byCountry.get(it.country) ?? new Set<string>();
        set.add(keyer(it));
        byCountry.set(it.country, set);
      }
      const arr = Array.from(byCountry.entries()).map(([country, set]) => ({ country, count: set.size }));
      arr.sort((a, b) => b.count - a.count);
      return { items: arr, total: arr.reduce((a, b) => a + b.count, 0) };
    };
    const samplePie = countryPieFrom(sendEvents, (s: SendRec) => s.key);
    const recoverPie = countryPieFrom(bdRecEvents, (r: RecRec) => r.vid);
    const country_pie = {
      sample: samplePie.items, sample_total: samplePie.total,
      recover: recoverPie.items, recover_total: recoverPie.total,
    };

    // ---- 粉丝分层（BD only，每个达人按自己国家的门槛定档，再合并）----
    // 国家占比图点某国下钻时，前端只是切到 by_country[国家] 这份数据（缩小参与统计的达人范围），
    // 具体某个达人用哪张门槛表定档，始终由该达人自己的国家决定，跟下钻/顶部筛选无关。
    const tierPieFrom = (items: { country: string; fan: number | null }[], keyer: (x: any) => string) => {
      const seen = new Set<string>();
      const counts: Record<Tier, number> = { 大: 0, 中: 0, 中小: 0, 小: 0, 特小: 0 };
      const byCountry = new Map<string, Record<Tier, number>>();
      for (const it of items as any[]) {
        const k = keyer(it);
        if (seen.has(k)) continue;
        seen.add(k);
        const t = tierOf(it.country, it.fan);
        counts[t]++;
        const cc = byCountry.get(it.country) ?? { 大: 0, 中: 0, 中小: 0, 小: 0, 特小: 0 };
        cc[t]++;
        byCountry.set(it.country, cc);
      }
      const arr = TIERS.map((t) => ({ tier: t, count: counts[t] }));
      const byCountryArr: Record<string, { tier: Tier; count: number }[]> = {};
      for (const [country, cc] of byCountry) byCountryArr[country] = TIERS.map((t) => ({ tier: t, count: cc[t] }));
      return { items: arr, total: arr.reduce((a, b) => a + b.count, 0), byCountry: byCountryArr };
    };
    // dedupe key for tiering = 达人身份 (handle, country) — fan_count 是该达人的属性
    const sampleTier = tierPieFrom(sendEvents, (s: SendRec) => `${s.handle}|${s.country}`);
    const recoverTier = tierPieFrom(bdRecEvents, (r: RecRec) => `${r.handle}|${r.country}`);
    const fan_tier_pie = {
      sample: sampleTier.items, sample_total: sampleTier.total, sample_by_country: sampleTier.byCountry,
      recover: recoverTier.items, recover_total: recoverTier.total, recover_by_country: recoverTier.byCountry,
      thresholds: { 大: { 其他: "≥100K", MX: "≥300K" }, 中: { 其他: "50–100K", MX: "100–300K" }, 中小: { 其他: "10–50K", MX: "30–100K" }, 小: { 其他: "3–10K", MX: "5–30K" }, 特小: { 其他: "<3K", MX: "<5K" } },
    };

    // ---- 每日发样/回收（BD only）----
    const days: string[] = [];
    for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) {
      days.push(d.toISOString().slice(0, 10));
    }
    const staffInScope = Array.from(new Set([...sendEvents.map((s) => s.staff), ...bdRecEvents.map((r) => r.staff)]));
    const byDate = <T extends { date: string }>(items: T[]) => {
      const m = new Map<string, T[]>();
      for (const it of items) { const arr = m.get(it.date) ?? []; arr.push(it); m.set(it.date, arr); }
      return m;
    };
    const sendByDate = byDate(sendEvents);
    const recByDate = byDate(bdRecEvents);
    const daily_series = days.map((date) => {
      const sendToday = sendByDate.get(date) ?? [];
      const recToday = recByDate.get(date) ?? [];
      const sampleCount = new Map<string, number>();
      const recoverCount = new Map<string, number>();
      for (const s of sendToday) sampleCount.set(s.staff, (sampleCount.get(s.staff) ?? 0) + 1);
      for (const r of recToday) recoverCount.set(r.staff, (recoverCount.get(r.staff) ?? 0) + 1);
      const by_staff: Record<string, { sample: number; recover: number }> = {};
      for (const st of staffInScope) {
        const sample = sampleCount.get(st) ?? 0;
        const recover = recoverCount.get(st) ?? 0;
        if (sample || recover) by_staff[st] = { sample, recover };
      }
      const sample = sendToday.length, recover = recToday.length;
      return { date, sample, recover, rate: safeDiv(recover, sample), by_staff };
    });

    return new Response(
      JSON.stringify({
        countries: countryList,
        staff: staffList,
        summary,
        grouped_rows,
        country_pie,
        fan_tier_pie,
        daily_series,
        last_synced_at: lastSyncedAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("connection-stats-query", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
