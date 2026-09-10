// Excel 广告表上传 + 归因。文件名约定「站点 MAX yyyymm.xlsx」→ 每文件一个批次。
//
// 【口径：上传与归因彻底解耦】
//   上传阶段只做两件事：把原始行落库（ad_upload_rows），再按 (VID, 达人昵称, 商品ID, 内容类型, 币种)
//   在数据库里归并成 ad_upload_agg（10 万行级 → 几千行）。**不计算、不存储任何归因结果。**
//   归因一律在出报表的那一刻现算：重新 loadAttrContext() 读当下的 creator_registry / creator_ownership /
//   creator_alias / site_handovers / attribution_review，再跑引擎。所以「同步达人登记」之后不需要重传、
//   不需要重跑批次，刷新报表就是新结果。ad_upload_rows.attr_* 四列已废弃，只留历史痕迹，不再读写。
//
// Body: { action, ... }
//   create   { file_name, country, month:'YYYY-MM', note?, force?, replace_existing? } → { upload_id }
//            站点必须是英文简写（PH / TH / VN / US / MX-AR…），含汉字直接拒收（force=true 可强制）
//   append   { upload_id, rows: ParsedRow[] } （≤2000 行/批，幂等键 (upload_id,row_no)）
//   finalize { upload_id } → 数据库内原子完成归并、汇率校验、金额汇总与置 READY；不读回归并明细
//   list     { month? } → { uploads }
//   get      { upload_id, detail_for? } 或 { month, merged:true } → { summary, uploads?, last_synced_at?, detail_rows? }
//   delete   { upload_id } 或 { upload_ids: [...] } 或 { all: true }
//   diagnose { month } → 归因口径自查：逐批次统计商品卡/VID命中/昵称同站点命中/昵称异站点/从未登记 + 站点写法对照
//   site_mismatch { month } → { rows }：现算后仍归 UNMATCHED、但名字在建联/别名表里（登记在别站点）的行
//   list_exchange_rates {} / save_exchange_rate { currency, usd_rate, enabled? }（usd_rate=1 美元兑多少本币）
//   export_vid_summary { month } → 按 (国家,VID,商品ID) 聚合的唯一 VID 汇总（14 列口径）
//   unmatched_trend    { month } → 以 month 为最近一个月往前 12 个月，逐月现算 UNMATCHED 桶并按 (国家,昵称) 聚合
//
// 【两层存储】第一层 = ad_upload_agg（达人昵称/VID 维度的原始数据）；第二层 = attribution_runs +
//   attribution_run_rows（一次「全站点全人员」归因的结果快照，带历史）。前台默认读最新快照，秒开；
//   每晚 cron 刷新一次，也可以手动「立即重算」。
//   refresh       { month | months[], source?, keep? } → 生成新快照（cron 走 x-cron-key 免口令）
//   report        { month } → { run, summary }：该月最新一次 READY 快照；没有则 run=null
//   report_detail { run_id, detail_for } → 从快照明细表下钻，不重算
//   runs          { month, limit? } → 快照历史
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, verifyPasscode } from "../_shared/auth.ts";
import {
  type AttrInputRow,
  type AttrRowResult,
  type AttrRunResult,
  attributeRows,
  hasCjk,
  identityKey,
  isHeaderLikeSite,
  normalizeCreativeType,
  normalizeName,
  splitIdentityKey,
  vidToPostedAt,
} from "../_shared/attribution.ts";
import {
  aggregateResults,
  findMissingCurrencies,
  loadAttrContext,
  loadExchangeRates,
  loadStaffMeta,
  loadTargets,
  monthRange,
  persistRunArtifacts,
} from "../_shared/attribution-report.ts";

const PAGE = 1000;
const DETAIL_CAP = 5000;

/** 归并行：一行 = 一个 (批次, VID, 达人昵称, 商品ID, 内容类型, 币种) 组。归因的输入单位。 */
type AggRow = {
  id: string;
  upload_id: string;
  country: string;
  month: string;
  vid: string;
  account_name: string;
  product_id: string;
  creative_type: string;
  currency: string;
  posted_at: string | null;
  rows_count: number;
  cost: number;
  gross_revenue: number;
  orders: number;
  impressions: number;
  clicks: number;
};

const AGG_COLUMNS =
  "id, upload_id, country, month, vid, account_name, product_id, creative_type, currency, posted_at, rows_count, cost, gross_revenue, orders, impressions, clicks";

type UploadRec = {
  id: string;
  file_name: string;
  country: string;
  month: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
};

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return String(v ?? "").trim();
}

/** 携带结构化 payload 的错误（前端可读 error.payload 拿到额外字段，如 missing_currencies）。 */
function errWithPayload(message: string, payload: Record<string, unknown>): Error & { payload: Record<string, unknown> } {
  const e = new Error(message) as Error & { payload: Record<string, unknown> };
  e.payload = payload;
  return e;
}

// ---------- 归并行 → 归因输入 ----------

function aggToInput(r: AggRow): AttrInputRow {
  let postedAt: string | null = null;
  let postedAtSource: AttrInputRow["postedAtSource"] = null;
  if (r.posted_at) {
    postedAt = r.posted_at;
    postedAtSource = "sheet";
  } else if (r.vid) {
    const d = vidToPostedAt(r.vid);
    if (d) {
      postedAt = d.toISOString();
      postedAtSource = "vid";
    }
  }
  return {
    key: `g:${r.id}`,
    creativeType: normalizeCreativeType(r.creative_type),
    vid: r.vid ?? "",
    accountName: r.account_name ?? "",
    country: r.country ?? "",
    postedAt,
    postedAtSource,
    currency: r.currency || "USD",
    cost: num(r.cost),
    grossRevenue: num(r.gross_revenue),
    orders: Math.round(num(r.orders)),
  };
}

async function fetchAgg(db: ReturnType<typeof admin>, uploadIds: string[]): Promise<AggRow[]> {
  const out: AggRow[] = [];
  for (let i = 0; i < uploadIds.length; i += 50) {
    const ids = uploadIds.slice(i, i + 50);
    let from = 0;
    for (;;) {
      const { data, error } = await db
        .from("ad_upload_agg")
        .select(AGG_COLUMNS)
        .in("upload_id", ids)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as AggRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  return out;
}

type LivePair = { input: AttrInputRow; result: AttrRowResult; agg: AggRow };

/**
 * 现算归因。每次都重新加载归因上下文（当下的飞书同步结果），不读任何固化的 attr_* 列。
 * persist=true 时把本次推断出的别名与审查项落库（只在「生成报表 / finalize」这种显式动作里做）。
 */
async function attributeNow(
  db: ReturnType<typeof admin>,
  aggRows: AggRow[],
  opts?: { persist?: boolean },
): Promise<{ pairs: LivePair[]; run: AttrRunResult }> {
  const inputs = aggRows.map(aggToInput);
  const ctx = await loadAttrContext(db);
  const run = attributeRows(inputs, ctx);
  if (opts?.persist) await persistRunArtifacts(db, run);
  const byKey = new Map(run.rows.map((r) => [r.key, r]));
  const pairs: LivePair[] = inputs.map((input, i) => ({ input, result: byKey.get(input.key)!, agg: aggRows[i] }));
  return { pairs, run };
}

async function getUpload(db: ReturnType<typeof admin>, uploadId: string): Promise<UploadRec> {
  const { data, error } = await db
    .from("ad_uploads")
    .select("id, file_name, country, month, period_start, period_end, status")
    .eq("id", uploadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("上传批次不存在");
  return data as UploadRec;
}

/** 某月全部已完成归并的批次。 */
async function readyUploads(db: ReturnType<typeof admin>, month: string) {
  const { data, error } = await db
    .from("ad_uploads")
    .select("id, file_name, country, month, period_start, period_end, status, row_count, total_revenue, attributed_at")
    .eq("month", month)
    .eq("status", "READY");
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<UploadRec & { row_count: number; total_revenue: number; attributed_at: string | null }>;
}

/**
 * 自愈：把「已 READY 但归并表里没有数据」的批次补跑一次归并。
 * 解耦改造之前 finalize 过的历史批次没有 ad_upload_agg 行，直接算会得到全 0 的报表；
 * 与其让用户挨个去点「重新归并」，不如在生成快照 / 自查时自动补上。
 */
async function ensureAgg(
  db: ReturnType<typeof admin>,
  uploads: Array<{ id: string; file_name: string }>,
): Promise<{ built: number; details: string[] }> {
  let built = 0;
  const details: string[] = [];
  for (const u of uploads) {
    const { count, error } = await db
      .from("ad_upload_agg")
      .select("id", { count: "exact", head: true })
      .eq("upload_id", u.id);
    if (error) throw new Error(error.message);
    if ((count ?? 0) > 0) continue;
    const t = Date.now();
    const { data, error: rpcErr } = await db.rpc("attribution_build_upload_agg", { _upload_id: u.id });
    if (rpcErr) {
      details.push(`${u.file_name}：补归并失败 ${rpcErr.message}`);
      console.error(`ensureAgg ${u.id} 失败`, rpcErr);
      continue;
    }
    const info = (Array.isArray(data) ? data[0] : data) as { agg_rows: number; raw_rows: number } | null;
    built++;
    details.push(`${u.file_name}：${Number(info?.raw_rows ?? 0)} 原始行 → ${Number(info?.agg_rows ?? 0)} 归并组（${Date.now() - t}ms）`);
    console.log(`ensureAgg ${u.file_name}: ${details[details.length - 1]}`);
  }
  return { built, details };
}

/**
 * 这个月要不要重跑快照。cron 默认带上这个判断，没有新数据就跳过，避免每晚白跑一遍。
 * 判定依据：该月有新完成的广告表批次，或达人登记有更新（两者都会改变归因结果）。
 */
async function monthNeedsRefresh(
  db: ReturnType<typeof admin>,
  month: string,
  run: RunMeta | null,
): Promise<{ needed: boolean; reason: string }> {
  if (!run) return { needed: true, reason: "该月还没有快照" };
  const since = run.started_at;

  const { data: ups, error: upErr } = await db
    .from("ad_uploads")
    .select("id")
    .eq("month", month)
    .eq("status", "READY")
    .gt("attributed_at", since)
    .limit(1);
  if (upErr) throw new Error(upErr.message);
  if (ups?.length) return { needed: true, reason: "该月有新完成的广告表批次" };

  const { data: own, error: ownErr } = await db
    .from("creator_ownership")
    .select("resolved_at")
    .gt("resolved_at", since)
    .limit(1);
  if (ownErr) throw new Error(ownErr.message);
  if (own?.length) return { needed: true, reason: "达人登记有更新" };

  return { needed: false, reason: "广告表和达人登记都没有变化" };
}

function detailFromPairs(pairs: LivePair[], f: { staff?: string; role?: string; bucket?: string }) {
  return pairs
    .filter(({ result }) => {
      if (f.bucket) return result.bucket === f.bucket;
      if (f.staff) {
        return result.bucket === "STAFF" && result.staff === f.staff && (!f.role || result.source === f.role);
      }
      return false;
    })
    .sort((a, b) => b.input.grossRevenue - a.input.grossRevenue)
    .slice(0, DETAIL_CAP)
    .map(({ input, result, agg }) => ({
      vid: input.vid,
      account_name: input.accountName,
      product_id: agg.product_id ?? null,
      creative_type: input.creativeType,
      country: result.country,
      gmv: input.grossRevenue,
      cost: input.cost,
      orders: input.orders,
      currency: input.currency,
      rows_count: agg.rows_count,
      bucket: result.bucket,
      staff: result.staff ?? null,
      source: result.source ?? null,
      match_type: result.matchType ?? null,
      posted_at: input.postedAt,
      posted_at_source: input.postedAtSource,
      handover_applied: result.handoverApplied ?? false,
    }));
}

/** 通用整表分页读取（诊断用的小表：creator_ownership / creator_alias）。 */
async function pageAllRows<T>(
  db: ReturnType<typeof admin>,
  table: string,
  columns: string,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ---------- 第二层：归因结果快照 ----------

type RunMeta = {
  id: string;
  month: string;
  source: string;
  triggered_by: string | null;
  status: string;
  upload_count: number;
  agg_rows: number;
  raw_rows: number;
  staff_count: number;
  total_gmv: number;
  total_cost: number;
  total_orders: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

const RUN_META_COLUMNS =
  "id, month, source, triggered_by, status, upload_count, agg_rows, raw_rows, staff_count, total_gmv, total_cost, total_orders, error, started_at, finished_at";

/**
 * 跑一次某月的「全站点全人员」归因并落成快照。
 * 归因本身仍然是按当下的飞书登记数据现算的，只是把结果固化下来供前台秒开；
 * 想要最新口径就再刷一次快照，不需要碰上传数据。
 */
async function buildSnapshot(
  db: ReturnType<typeof admin>,
  month: string,
  source: string,
  triggeredBy: string,
  keep: number,
): Promise<{ run: RunMeta; summary: unknown }> {
  const { data: created, error: insErr } = await db
    .from("attribution_runs")
    .insert({ month, source, triggered_by: triggeredBy, status: "RUNNING" })
    .select(RUN_META_COLUMNS)
    .single();
  if (insErr) throw new Error(insErr.message);
  const runId = (created as RunMeta).id;

  try {
    const uploads = await readyUploads(db, month);
    // 历史批次可能还没归并过（解耦改造之前 finalize 的），这里自动补上，否则会算出一张全 0 的报表
    if (uploads.length) {
      const healed = await ensureAgg(db, uploads);
      if (healed.built) console.log(`buildSnapshot ${month}: 补归并 ${healed.built} 个批次`);
    }
    const { start, end } = monthRange(month);
    const [targets, exchangeRates, staffMeta] = await Promise.all([
      loadTargets(db, month),
      loadExchangeRates(db),
      loadStaffMeta(db),
    ]);
    const aggRows = uploads.length ? await fetchAgg(db, uploads.map((u) => u.id)) : [];
    const { pairs } = aggRows.length
      ? await attributeNow(db, aggRows, { persist: true })
      : { pairs: [] as LivePair[] };
    const summary = aggregateResults(pairs, { period: { start, end }, month, targets, exchangeRates, staffMeta });

    // 明细快照：一行 = 一个归并组的归因结果，下钻直接查这张表
    const detailRows = pairs.map(({ input, result, agg }) => {
      const cur = (input.currency || "USD").toUpperCase();
      const rate = exchangeRates.get(cur) ?? (cur === "USD" ? 1 : 0);
      return {
        run_id: runId,
        month,
        country: result.country || input.country || "",
        vid: input.vid,
        account_name: input.accountName,
        product_id: agg.product_id ?? "",
        creative_type: input.creativeType,
        currency: cur,
        rows_count: agg.rows_count ?? 0,
        cost: input.cost,
        gross_revenue: input.grossRevenue,
        orders: input.orders,
        cost_usd: rate ? input.cost / rate : 0,
        gmv_usd: rate ? input.grossRevenue / rate : 0,
        bucket: result.bucket,
        staff: result.staff ?? null,
        role: result.source ?? null,
        match_type: result.matchType ?? null,
        handover_applied: result.handoverApplied ?? false,
        posted_at: input.postedAt,
        posted_at_source: input.postedAtSource,
      };
    });
    for (let i = 0; i < detailRows.length; i += 1000) {
      const { error } = await db.from("attribution_run_rows").insert(detailRows.slice(i, i + 1000));
      if (error) throw new Error(error.message);
    }

    const rawRows = uploads.reduce((n, u) => n + (u.row_count ?? 0), 0);
    const { data: done, error: updErr } = await db
      .from("attribution_runs")
      .update({
        status: "READY",
        upload_count: uploads.length,
        agg_rows: aggRows.length,
        raw_rows: rawRows,
        staff_count: summary.staff.length,
        total_gmv: summary.totals.gmv,
        total_cost: summary.totals.cost,
        total_orders: summary.totals.orders,
        summary,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .select(RUN_META_COLUMNS)
      .single();
    if (updErr) throw new Error(updErr.message);

    await db.rpc("attribution_runs_prune", { _month: month, _keep: keep });
    return { run: done as RunMeta, summary };
  } catch (e) {
    await db
      .from("attribution_runs")
      .update({ status: "FAILED", error: (e as Error).message, finished_at: new Date().toISOString() })
      .eq("id", runId);
    throw e;
  }
}

/** 某月最新一次成功的快照。 */
async function latestRun(db: ReturnType<typeof admin>, month: string): Promise<RunMeta | null> {
  const { data, error } = await db
    .from("attribution_runs")
    .select(RUN_META_COLUMNS)
    .eq("month", month)
    .eq("status", "READY")
    .order("finished_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as RunMeta[];
  return rows[0] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // cron 免口令：pg_cron 经服务端路由带上 x-cron-key（vault secret），只允许用于 refresh
    const cronKey = req.headers.get("x-cron-key") ?? "";
    let cronAuthed = false;
    if (cronKey) {
      const { data: ok } = await admin().rpc("verify_gmv_cron_key", { _key: cronKey });
      if (ok === true) cronAuthed = true;
    }
    const body = (await req.json()) as Record<string, unknown>;
    const action = str(body.action);
    if (cronAuthed && action !== "refresh") throw new Error("cron 只允许调用 refresh");
    const account = cronAuthed
      ? { name: "cron" }
      : await verifyPasscode(req, "gmv-attribution-admin");
    const db = admin();

    if (action === "create") {
      const fileName = str(body.file_name);
      const country = str(body.country);
      const month = str(body.month);
      if (!fileName) throw new Error("file_name 必填");
      if (!country) throw new Error("country 必填（从文件名「站点 MAX yyyymm.xlsx」解析或手动指定）");
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      // 站点写法全系统统一用英文简写；含汉字的站点永远匹配不上飞书登记表，直接在入口拦掉
      if (!body.force && hasCjk(country)) {
        throw new Error(
          `站点「${country}」含汉字。站点写法统一用英文简写（PH / TH / VN / MY / SG / MX-AR / US / JP…），` +
            `请把文件名改成「PH MAX ${month.replace("-", "")}.xlsx」这种形式后重新上传。`,
        );
      }
      if (!body.force) {
        const { data: ac } = await db.from("advertiser_countries").select("country");
        const known = new Set(((ac ?? []) as { country: string }[]).map((r) => r.country.trim()));
        if (known.size && !known.has(country)) {
          throw new Error(`站点「${country}」不在 advertiser_countries 中（已知：${Array.from(known).join("、")}）。确认无误可 force=true 强制创建`);
        }
      }
      // 只挡「同名文件重复上传」，不挡同站点同月的多份分文件（如 JP MAX 202508.1/.2.xlsx 属正常分卷，需按月合并求和）
      if (!body.replace_existing) {
        const { data: dup, error: dupErr } = await db
          .from("ad_uploads")
          .select("file_name, status")
          .eq("country", country)
          .eq("month", month)
          .eq("file_name", fileName)
          .in("status", ["UPLOADING", "READY"]);
        if (dupErr) throw new Error(dupErr.message);
        if (dup && dup.length) {
          const desc = dup.map((d: { file_name: string; status: string }) => `${d.file_name}（${d.status}）`).join("、");
          throw errWithPayload(
            `该文件名已上传过（${desc}），请先在列表里删除旧记录，或勾选替换后重试`,
            { duplicate: true },
          );
        }
      } else {
        const { error: delErr } = await db
          .from("ad_uploads")
          .delete()
          .eq("country", country)
          .eq("month", month)
          .eq("file_name", fileName);
        if (delErr) throw new Error(delErr.message);
      }

      const { start, end } = monthRange(month);
      const { data, error } = await db
        .from("ad_uploads")
        .insert({
          file_name: fileName,
          country,
          month,
          uploaded_by: account.name,
          period_start: start,
          period_end: end,
          note: str(body.note) || null,
          status: "UPLOADING",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return json({ upload_id: (data as { id: string }).id });
    }

    if (action === "append") {
      const uploadId = str(body.upload_id);
      if (!uploadId) throw new Error("upload_id 必填");
      const rows = (body.rows ?? []) as Record<string, unknown>[];
      if (!Array.isArray(rows) || !rows.length) throw new Error("rows 不能为空");
      if (rows.length > 2000) throw new Error("单批最多 2000 行");
      const payload = rows.map((r) => ({
        upload_id: uploadId,
        row_no: Math.round(num(r.row_no)),
        campaign_name: str(r.campaign_name) || null,
        campaign_id: str(r.campaign_id),
        product_id: str(r.product_id),
        creative_type: str(r.creative_type),
        video_title: str(r.video_title).slice(0, 2000) || null,
        vid: str(r.vid),
        tt_account_name: str(r.tt_account_name),
        posted_at: str(r.posted_at) || null,
        status: str(r.status) || null,
        authorization_type: str(r.authorization_type) || null,
        cost: num(r.cost),
        orders: Math.round(num(r.orders)),
        gross_revenue: num(r.gross_revenue),
        roi: str(r.roi) === "" ? null : num(r.roi),
        impressions: str(r.impressions) === "" ? null : Math.round(num(r.impressions)),
        clicks: str(r.clicks) === "" ? null : Math.round(num(r.clicks)),
        currency: str(r.currency) || null,
      }));
      const { error } = await db.from("ad_upload_rows").upsert(payload, { onConflict: "upload_id,row_no" });
      if (error) throw new Error(error.message);
      return json({ inserted: payload.length });
    }

    // 归并 + 置 READY。整个过程留在数据库内，避免把 10 万行级归并结果读回 Worker。
    if (action === "finalize") {
      const uploadId = str(body.upload_id);
      await getUpload(db, uploadId);

      const t0 = Date.now();
      const { data: finalizeInfo, error: finalizeErr } = await db.rpc("attribution_finalize_upload", { _upload_id: uploadId });
      if (finalizeErr) throw new Error(`归并失败：${finalizeErr.message}`);
      const info = (Array.isArray(finalizeInfo) ? finalizeInfo[0] : finalizeInfo) as {
        agg_rows: number;
        raw_rows: number;
        missing_currencies: string[] | null;
      } | null;
      const rawRows = Number(info?.raw_rows ?? 0);
      if (!rawRows) throw new Error("该批次没有数据行");
      console.log(`finalize ${uploadId}: ${rawRows} 原始行 → ${info?.agg_rows ?? 0} 归并行，耗时 ${Date.now() - t0}ms`);

      const missing = info?.missing_currencies ?? [];
      if (missing.length) {
        throw errWithPayload(
          `缺少汇率配置：${missing.join("、")}，请先在设置页维护汇率后重试`,
          { missing_currencies: missing },
        );
      }

      return json({ row_count: rawRows, agg_rows: Number(info?.agg_rows ?? 0) });
    }

    if (action === "list") {
      // 上限放大到 2000：站点数×月份数量级很小，但前端「上传状态矩阵」需要看到全部历史，不能只取最近 100 条
      let q = db
        .from("ad_uploads")
        .select("id, file_name, country, month, uploaded_by, period_start, period_end, row_count, total_cost, total_revenue, status, attributed_at, note, created_at")
        .order("created_at", { ascending: false })
        .limit(2000);
      const month = str(body.month);
      if (month) q = q.eq("month", month);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json({ uploads: data ?? [] });
    }

    if (action === "get") {
      const detailFor = (body.detail_for ?? null) as { staff?: string; role?: string; bucket?: string } | null;

      if (body.merged) {
        const month = str(body.month);
        if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("merged 视图需要 month（YYYY-MM）");
        const uploads = await readyUploads(db, month);
        const { start, end } = monthRange(month);
        const [targets, exchangeRates, staffMeta] = await Promise.all([
          loadTargets(db, month),
          loadExchangeRates(db),
          loadStaffMeta(db),
        ]);
        if (!uploads.length) {
          // 该月没有批次时返回空报表而不是报错（避免前端白屏）
          return json({
            summary: aggregateResults([], { period: { start, end }, month, targets, exchangeRates, staffMeta }),
            uploads: [],
            last_synced_at: null,
            detail_rows: detailFor ? [] : undefined,
          });
        }
        const aggRows = await fetchAgg(db, uploads.map((u) => u.id));
        // 「生成报表」是显式动作，这里顺带把新推断的别名与审查项落库
        const { pairs } = await attributeNow(db, aggRows, { persist: true });
        const summary = aggregateResults(pairs, { period: { start, end }, month, targets, exchangeRates, staffMeta });
        const lastSyncedAt = uploads.reduce<string | null>(
          (acc, u) => (u.attributed_at && (!acc || u.attributed_at > acc) ? u.attributed_at : acc),
          null,
        );
        return json({
          summary,
          uploads,
          last_synced_at: lastSyncedAt,
          detail_rows: detailFor ? detailFromPairs(pairs, detailFor) : undefined,
        });
      }

      const uploadId = str(body.upload_id);
      const upload = await getUpload(db, uploadId);
      const aggRows = await fetchAgg(db, [uploadId]);
      const { pairs } = await attributeNow(db, aggRows);
      const [targets, exchangeRates, staffMeta] = await Promise.all([
        loadTargets(db, upload.month),
        loadExchangeRates(db),
        loadStaffMeta(db),
      ]);
      const summary = aggregateResults(pairs, {
        period: { start: upload.period_start ?? "", end: upload.period_end ?? "" },
        month: upload.month,
        targets,
        exchangeRates,
        staffMeta,
      });
      return json({
        summary,
        upload,
        detail_rows: detailFor ? detailFromPairs(pairs, detailFor) : undefined,
      });
    }

    // ---------- 第二层：快照 ----------

    // 生成新快照。cron 每晚跑一次全部近月；页面上「立即重算」跑当前月。
    if (action === "refresh") {
      const keep = Math.max(1, Math.min(50, Math.round(num(body.keep)) || 10));
      const source = str(body.source) || (cronAuthed ? "CRON" : "MANUAL");
      let months: string[] = Array.isArray(body.months)
        ? (body.months as unknown[]).map(str).filter((m) => /^\d{4}-\d{2}$/.test(m))
        : [];
      const single = str(body.month);
      if (single) {
        if (!/^\d{4}-\d{2}$/.test(single)) throw new Error("month 格式应为 YYYY-MM");
        months = [single];
      }
      if (!months.length) {
        // 不指定月份 = 刷新「有已完成批次的最近 N 个月」，cron 走这条路
        const lookback = Math.max(1, Math.min(24, Math.round(num(body.lookback_months)) || 3));
        const { data, error } = await db
          .from("ad_uploads")
          .select("month")
          .eq("status", "READY")
          .order("month", { ascending: false })
          .limit(2000);
        if (error) throw new Error(error.message);
        const seen: string[] = [];
        for (const r of (data ?? []) as { month: string }[]) {
          if (r.month && !seen.includes(r.month)) seen.push(r.month);
        }
        months = seen.slice(0, lookback);
      }

      // cron 默认只在「有新数据」时才跑；页面上手动点「重新计算」永远强制重算
      const skipIfUnchanged = body.skip_if_unchanged === undefined ? cronAuthed : !!body.skip_if_unchanged;

      const results: Array<{ month: string; ok: boolean; skipped?: boolean; reason?: string; run?: RunMeta; error?: string }> = [];
      for (const m of months) {
        try {
          if (skipIfUnchanged) {
            const prev = await latestRun(db, m);
            const { needed, reason } = await monthNeedsRefresh(db, m, prev);
            if (!needed) {
              results.push({ month: m, ok: true, skipped: true, reason, run: prev ?? undefined });
              console.log(`refresh ${m}: 跳过（${reason}）`);
              continue;
            }
          }
          const { run } = await buildSnapshot(db, m, source, account.name, keep);
          results.push({ month: m, ok: true, run });
          console.log(`refresh ${m}: ${run.agg_rows} 归并行 → ${run.staff_count} 人，GMV ${Math.round(run.total_gmv)}`);
        } catch (e) {
          results.push({ month: m, ok: false, error: (e as Error).message });
          console.error(`refresh ${m} 失败`, e);
        }
      }
      return json({ months, results });
    }

    // 前台默认入口：读该月最新快照，不重算。run=null 表示还没跑过，前端提示「立即重算」。
    if (action === "report") {
      const month = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      const run = await latestRun(db, month);
      if (!run) return json({ run: null, summary: null });
      const { data, error } = await db.from("attribution_runs").select("summary").eq("id", run.id).single();
      if (error) throw new Error(error.message);
      return json({ run, summary: (data as { summary: unknown }).summary });
    }

    // 快照明细下钻：直接查快照明细表，不重算
    if (action === "report_detail") {
      const f = (body.detail_for ?? {}) as { staff?: string; role?: string; bucket?: string };
      let runId = str(body.run_id);
      if (!runId) {
        const month = str(body.month);
        if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("run_id 或 month 必填");
        const run = await latestRun(db, month);
        if (!run) return json({ detail_rows: [] });
        runId = run.id;
      }
      let q = db
        .from("attribution_run_rows")
        .select("vid, account_name, product_id, creative_type, country, currency, rows_count, cost, gross_revenue, orders, gmv_usd, cost_usd, bucket, staff, role, match_type, handover_applied, posted_at, posted_at_source")
        .eq("run_id", runId)
        .order("gmv_usd", { ascending: false })
        .limit(DETAIL_CAP);
      if (f.bucket) {
        q = q.eq("bucket", f.bucket);
      } else if (f.staff) {
        q = q.eq("bucket", "STAFF").eq("staff", f.staff);
        if (f.role) q = q.eq("role", f.role);
      } else {
        return json({ detail_rows: [] });
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      // 明细里的金额统一按快照生成时的汇率折美元，和进度板口径一致
      const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        vid: r.vid,
        account_name: r.account_name,
        product_id: r.product_id,
        creative_type: r.creative_type,
        country: r.country,
        currency: r.currency,
        rows_count: r.rows_count,
        gmv: num(r.gmv_usd),
        cost: num(r.cost_usd),
        orders: Math.round(num(r.orders)),
        bucket: r.bucket,
        staff: r.staff,
        source: r.role,
        match_type: r.match_type,
        handover_applied: r.handover_applied,
        posted_at: r.posted_at,
        posted_at_source: r.posted_at_source,
      }));
      return json({ detail_rows: rows, run_id: runId });
    }

    // 快照历史
    if (action === "runs") {
      const month = str(body.month);
      const limit = Math.max(1, Math.min(50, Math.round(num(body.limit)) || 20));
      let q = db.from("attribution_runs").select(RUN_META_COLUMNS).order("started_at", { ascending: false }).limit(limit);
      if (month) q = q.eq("month", month);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json({ runs: data ?? [] });
    }

    if (action === "list_exchange_rates") {
      const { data, error } = await db
        .from("gmv_exchange_rates")
        .select("currency, usd_rate, enabled, updated_at, updated_by")
        .order("currency", { ascending: true });
      if (error) throw new Error(error.message);
      return json({ rates: data ?? [] });
    }

    if (action === "save_exchange_rate") {
      const currency = str(body.currency).toUpperCase();
      const usdRate = Number(body.usd_rate);
      if (!currency) throw new Error("currency 必填");
      if (!isFinite(usdRate) || usdRate <= 0) throw new Error("usd_rate 必须为正数（1 美元 = 多少本币）");
      const enabled = body.enabled === undefined ? true : !!body.enabled;
      const { data, error } = await db
        .from("gmv_exchange_rates")
        .upsert(
          { currency, usd_rate: usdRate, enabled, updated_by: account.name, updated_at: new Date().toISOString() },
          { onConflict: "currency" },
        )
        .select("currency, usd_rate, enabled, updated_at, updated_by")
        .single();
      if (error) throw new Error(error.message);
      return json({ rate: data });
    }

    // 唯一 VID 汇总：归并表本身就是按 (VID, 昵称, 商品ID) 分组的，这里只需跨批次再合一次
    if (action === "export_vid_summary") {
      const month = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      const uploads = await readyUploads(db, month);
      if (!uploads.length) throw new Error(`没有 ${month} 已完成上传的批次`);
      const aggRows = await fetchAgg(db, uploads.map((u) => u.id));
      const exchangeRates = await loadExchangeRates(db);

      type Group = {
        country: string;
        vid: string;
        product_id: string;
        gmvUsd: number;
        costUsd: number;
        orders: number;
        impressions: number;
        clicks: number;
        accountNameCounts: Map<string, number>;
      };
      const groups = new Map<string, Group>();
      for (const r of aggRows) {
        const cur = (r.currency || "USD").toUpperCase();
        const rate = exchangeRates.get(cur) ?? (cur === "USD" ? 1 : 0);
        if (!rate) continue; // 理论上不会发生：finalize 已强制要求补齐汇率
        const key = `${r.country}|${r.vid}|${r.product_id ?? ""}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            country: r.country, vid: r.vid, product_id: r.product_id ?? "",
            gmvUsd: 0, costUsd: 0, orders: 0, impressions: 0, clicks: 0, accountNameCounts: new Map(),
          };
          groups.set(key, g);
        }
        g.gmvUsd += num(r.gross_revenue) / rate;
        g.costUsd += num(r.cost) / rate;
        g.orders += Math.round(num(r.orders));
        g.impressions += Math.round(num(r.impressions));
        g.clicks += Math.round(num(r.clicks));
        const name = (r.account_name ?? "").trim() || "（无账号）";
        g.accountNameCounts.set(name, (g.accountNameCounts.get(name) ?? 0) + (r.rows_count || 1));
      }

      const productIds = Array.from(new Set(Array.from(groups.values()).map((g) => g.product_id).filter(Boolean)));
      const skuByKey = new Map<string, string>();
      if (productIds.length) {
        const CHUNK = 500;
        for (let i = 0; i < productIds.length; i += CHUNK) {
          const { data: skuRows, error: skuErr } = await db
            .from("sku_product_map")
            .select("country, product_id, merchant_sku")
            .in("product_id", productIds.slice(i, i + CHUNK));
          if (skuErr) throw new Error(skuErr.message);
          for (const r of (skuRows ?? []) as { country: string; product_id: string; merchant_sku: string }[]) {
            const key = `${r.country}|${r.product_id}`;
            if (!skuByKey.has(key)) skuByKey.set(key, r.merchant_sku ?? "");
          }
        }
      }

      const rowsOut = Array.from(groups.values()).map((g) => {
        let bestName = "";
        let bestCount = -1;
        for (const [name, cnt] of g.accountNameCounts) {
          if (cnt > bestCount) { bestName = name; bestCount = cnt; }
        }
        return {
          country: g.country,
          month,
          vid: g.vid,
          account_name: bestName,
          product_id: g.product_id,
          sku: skuByKey.get(`${g.country}|${g.product_id}`) ?? "",
          gmv: g.gmvUsd,
          cost: g.costUsd,
          orders: g.orders,
          roi: g.costUsd > 0 ? g.gmvUsd / g.costUsd : null,
          pv: g.impressions,
          clicks: g.clicks,
          ctr: g.impressions > 0 ? g.clicks / g.impressions : null,
          cvr: g.clicks > 0 ? g.orders / g.clicks : null,
        };
      });
      return json({ rows: rowsOut });
    }

    // 12 个月无建联趋势：逐月现算（归并后每月只有几千行，够快），不再依赖已废弃的 attr_bucket
    if (action === "unmatched_trend") {
      const anchorMonth = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(anchorMonth)) throw new Error("month 格式应为 YYYY-MM");
      const months: string[] = [];
      {
        const [y, m] = anchorMonth.split("-").map(Number);
        for (let i = 0; i < 12; i++) {
          const d = new Date(Date.UTC(y, m - 1 - i, 1));
          months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
        }
      }
      const exchangeRates = await loadExchangeRates(db);
      const ctx = await loadAttrContext(db); // 12 个月共用一次上下文
      type Agg = { country: string; account_name: string; byMonth: Map<string, number> };
      const aggMap = new Map<string, Agg>();
      for (const trendMonth of months) {
        const uploads = await readyUploads(db, trendMonth);
        if (!uploads.length) continue;
        const aggRows = await fetchAgg(db, uploads.map((u) => u.id));
        const inputs = aggRows.map(aggToInput);
        const run = attributeRows(inputs, ctx);
        const byKey = new Map(run.rows.map((r) => [r.key, r]));
        for (const input of inputs) {
          if (byKey.get(input.key)?.bucket !== "UNMATCHED") continue;
          const name = input.accountName.trim();
          const norm = normalizeName(name);
          if (!norm) continue;
          const cur = (input.currency || "USD").toUpperCase();
          const rate = exchangeRates.get(cur) ?? (cur === "USD" ? 1 : 0);
          if (!rate) continue;
          const key = `${input.country}|${norm}`;
          let agg = aggMap.get(key);
          if (!agg) {
            agg = { country: input.country, account_name: name, byMonth: new Map() };
            aggMap.set(key, agg);
          }
          agg.byMonth.set(trendMonth, (agg.byMonth.get(trendMonth) ?? 0) + input.grossRevenue / rate);
        }
      }
      const rowsOut = Array.from(aggMap.values())
        .map((a) => {
          const byMonth: Record<string, number> = {};
          let total = 0;
          for (const m of months) {
            const v = a.byMonth.get(m) ?? 0;
            byMonth[m] = v;
            total += v;
          }
          return { country: a.country, account_name: a.account_name, total, by_month: byMonth };
        })
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total);
      return json({ months, rows: rowsOut });
    }

    if (action === "delete") {
      // ad_upload_rows / ad_upload_agg 的 upload_id 都是 ON DELETE CASCADE，删批次会连行一起删
      if (body.all === true) {
        // 全量清空走 TRUNCATE RPC：级联 DELETE 几十万行会触发 statement timeout
        const { data, error } = await db.rpc("attribution_uploads_delete_all");
        if (error) throw new Error(error.message);
        return json({ deleted: typeof data === "number" ? data : 0 });
      }
      const ids = Array.isArray(body.upload_ids)
        ? (body.upload_ids as unknown[]).map(str).filter(Boolean)
        : [str(body.upload_id)].filter(Boolean);
      if (!ids.length) throw new Error("upload_id / upload_ids 必填");
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const { count, error } = await db
          .from("ad_uploads")
          .delete({ count: "exact" })
          .in("id", ids.slice(i, i + 100));
        if (error) throw new Error(error.message);
        deleted += count ?? 0;
      }
      return json({ deleted });
    }

    // 「为什么一个人都归不上」的自查：把归因瀑布每一层的命中量摊开，直接指出是哪一层断了。
    if (action === "diagnose") {
      const month = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      const uploads = await readyUploads(db, month);
      // 和生成快照一样先自愈：没归并过的历史批次先补上，否则自查每一格都是 0，看不出真实原因
      const healed = uploads.length ? await ensureAgg(db, uploads) : { built: 0, details: [] as string[] };
      const ctx = await loadAttrContext(db);

      // 名字（不分站点）→ 已登记站点集合，用于区分「名字没登记过」和「名字登记在别的站点」
      const sitesByName = new Map<string, Set<string>>();
      const addName = (key: string) => {
        const { country, normalizedName } = splitIdentityKey(key);
        if (!normalizedName) return;
        const set = sitesByName.get(normalizedName) ?? new Set<string>();
        set.add(country || "（空）");
        sitesByName.set(normalizedName, set);
      };
      for (const k of ctx.ownership.keys()) addName(k);
      for (const k of ctx.manualAlias.keys()) addName(k);
      for (const k of ctx.vidAlias.keys()) addName(k);

      const registryCountries = new Map<string, number>();
      for (const k of ctx.ownership.keys()) {
        const c = splitIdentityKey(k).country || "（空）";
        registryCountries.set(c, (registryCountries.get(c) ?? 0) + 1);
      }
      const vidCountries = new Map<string, number>();
      for (const regs of ctx.vidRegs.values()) {
        for (const r of regs) {
          const c = (r.country || "（空）").toUpperCase();
          vidCountries.set(c, (vidCountries.get(c) ?? 0) + 1);
        }
      }

      type Layer = {
        rows: number;
        agg_rows: number;
        product_card: number;
        vid_rows: number;
        vid_hit: number;
        no_name: number;
        name_hit_same_site: number;
        /** 名字登记过、但登记站点和上传站点不一致 → 按现行口径判 UNMATCHED */
        name_hit_other_site: number;
        name_never_registered: number;
        other_site_samples: Array<{ account_name: string; registered_sites: string[] }>;
      };
      const emptyLayer = (): Layer => ({
        rows: 0, agg_rows: 0, product_card: 0, vid_rows: 0, vid_hit: 0, no_name: 0,
        name_hit_same_site: 0, name_hit_other_site: 0, name_never_registered: 0, other_site_samples: [],
      });
      const total = emptyLayer();
      const perUpload: Array<{ file_name: string; country: string; status: string } & Layer> = [];

      for (const u of uploads) {
        const layer = emptyLayer();
        const aggRows = await fetchAgg(db, [u.id]);
        for (const r of aggRows) {
          const n = r.rows_count || 1;
          layer.rows += n;
          layer.agg_rows++;
          if (normalizeCreativeType(r.creative_type) === "product_card") {
            layer.product_card += n;
            continue;
          }
          if (r.vid) {
            layer.vid_rows += n;
            if (ctx.vidRegs.has(r.vid)) {
              layer.vid_hit += n;
              continue;
            }
          }
          const norm = normalizeName(r.account_name);
          if (!norm) {
            layer.no_name += n;
            continue;
          }
          const scoped = identityKey(u.country, norm);
          if (ctx.manualAlias.has(scoped) || ctx.ownership.has(scoped) || ctx.vidAlias.has(scoped)) {
            layer.name_hit_same_site += n;
            continue;
          }
          const sites = sitesByName.get(norm);
          if (sites?.size) {
            layer.name_hit_other_site += n;
            if (layer.other_site_samples.length < 10) {
              layer.other_site_samples.push({
                account_name: (r.account_name ?? "").trim(),
                registered_sites: Array.from(sites).slice(0, 5),
              });
            }
          } else {
            layer.name_never_registered += n;
          }
        }
        perUpload.push({ file_name: u.file_name, country: u.country, status: u.status, ...layer });
        total.rows += layer.rows;
        total.agg_rows += layer.agg_rows;
        total.product_card += layer.product_card;
        total.vid_rows += layer.vid_rows;
        total.vid_hit += layer.vid_hit;
        total.no_name += layer.no_name;
        total.name_hit_same_site += layer.name_hit_same_site;
        total.name_hit_other_site += layer.name_hit_other_site;
        total.name_never_registered += layer.name_never_registered;
      }

      // 结论：按归因瀑布从上往下，第一条断掉的就是主因
      const hints: string[] = [];
      if (!uploads.length) hints.push(`${month} 没有任何已完成上传的批次，先上传广告表。`);
      if (!ctx.vidRegs.size && !ctx.ownership.size) {
        hints.push("VID 登记表和建联归属表都是空的 —— 说明「同步达人登记」从来没成功跑过（或跑完被清空了）。先点「同步达人登记」，看返回的登记行数是否 > 0。");
      } else {
        if (!ctx.vidRegs.size) hints.push("VID 登记为空：staff_vid_map 与 creator_registry 都没有带 VID 的记录，VID 强匹配这一层完全失效。");
        if (!ctx.ownership.size) hints.push("建联归属为空：creator_ownership 没有记录，昵称匹配这一层完全失效。");
      }
      if (total.vid_rows > 0 && total.vid_hit === 0 && ctx.vidRegs.size > 0) {
        hints.push(`广告表里有 ${total.vid_rows} 行带 VID，但没有一个 VID 出现在登记表（登记表共 ${ctx.vidRegs.size} 个 VID）。检查飞书建联表 P 列 / 授权记录 Q 列 / 剪辑表 G 列的 VID 是否真的填了、是否 19 位且以 7 开头。`);
      }
      // 表头、占位符不算「填错的站点」，不要拿它们去烦用户
      const cjkSites = Array.from(registryCountries.keys()).filter((c) => hasCjk(c) && !isHeaderLikeSite(c));
      if (cjkSites.length) {
        hints.push(`建联表里有 ${cjkSites.length} 种汉字站点写法（${cjkSites.slice(0, 10).join("、")}）。站点统一用英文简写，含汉字的行永远匹配不上，请到飞书把这些改成 PH / TH / VN / US / MX-AR 这类代码后重新同步。`);
      }
      if (healed.built) {
        hints.push(`本次自查顺带补跑了 ${healed.built} 个批次的归并（这些批次是解耦改造之前上传的，之前没有归并数据）：${healed.details.slice(0, 5).join("；")}`);
      }
      if (total.name_hit_other_site > 0 && total.name_hit_other_site >= total.name_hit_same_site) {
        const upSites = Array.from(new Set(uploads.map((u) => u.country))).join("、");
        const regSites = Array.from(registryCountries.keys()).slice(0, 15).join("、");
        hints.push(`有 ${total.name_hit_other_site} 行的达人名字在登记表里存在，但登记站点和上传站点对不上，按现行口径一律判「无建联」。上传站点写法：${upSites}；登记表站点写法：${regSites}。两边必须逐字一致。`);
      }
      if (total.name_never_registered > 0 && total.name_hit_same_site === 0 && total.vid_hit === 0) {
        hints.push(`还有 ${total.name_never_registered} 行的达人名字在建联/别名表里完全查不到，这部分是真正的「无建联达人」。`);
      }
      if (!hints.length) hints.push("各层都有命中，归因口径本身没有断点。");

      return json({
        month,
        context: {
          vid_count: ctx.vidRegs.size,
          ownership_keys: ctx.ownership.size,
          manual_alias: ctx.manualAlias.size,
          vid_alias: ctx.vidAlias.size,
          handover_countries: ctx.handovers.size,
          review_overrides: ctx.reviewOverrides.size,
        },
        upload_countries: Array.from(new Set(uploads.map((u) => u.country))).sort(),
        registry_countries: Array.from(registryCountries.entries())
          .map(([country, keys]) => ({ country, keys }))
          .sort((a, b) => b.keys - a.keys),
        vid_countries: Array.from(vidCountries.entries())
          .map(([country, rows]) => ({ country, rows }))
          .sort((a, b) => b.rows - a.rows),
        uploads: perUpload,
        totals: total,
        healed: healed.built,
        hints,
      });
    }

    if (action === "site_mismatch") {
      const month = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      const uploads = await readyUploads(db, month);
      if (!uploads.length) throw new Error(`没有 ${month} 已完成上传的批次`);

      // 建联归属 + 别名，按「归一化名字」建索引（不含站点），只用于诊断、不参与归因
      type Owner = { bd: string; country: string; source: string };
      const byName = new Map<string, Owner[]>();
      const addOwner = (name: string, o: Owner) => {
        const norm = normalizeName(name);
        if (!norm) return;
        const arr = byName.get(norm) ?? [];
        if (!arr.some((x) => x.bd === o.bd && x.country === o.country && x.source === o.source)) arr.push(o);
        byName.set(norm, arr);
      };
      {
        const rows = await pageAllRows<{ key_type: string; match_key: string; owner_bd: string; country: string }>(
          db, "creator_ownership", "key_type, match_key, owner_bd, country",
        );
        for (const r of rows) {
          addOwner(r.match_key, { bd: r.owner_bd, country: r.country ?? "", source: r.key_type === "HANDLE" ? "建联-用户名" : "建联-昵称" });
        }
        const aliases = await pageAllRows<{ alias_norm: string; bd_name: string; country: string; source: string }>(
          db, "creator_alias", "alias_norm, bd_name, country, source",
        );
        for (const r of aliases) {
          addOwner(r.alias_norm, { bd: r.bd_name, country: r.country ?? "", source: r.source === "MANUAL" ? "人工判定别名" : "VID推断别名" });
        }
      }

      const exchangeRates = await loadExchangeRates(db);
      const aggRows = await fetchAgg(db, uploads.map((u) => u.id));
      const { pairs } = await attributeNow(db, aggRows);

      type Miss = {
        upload_country: string;
        account_name: string;
        rows: number;
        gmv_usd: number;
        registered: Owner[];
      };
      const missMap = new Map<string, Miss>();
      for (const { input, result, agg } of pairs) {
        if (result.bucket !== "UNMATCHED") continue;
        const raw = (input.accountName ?? "").trim();
        const norm = normalizeName(raw);
        if (!norm) continue;
        const owners = byName.get(norm);
        if (!owners?.length) continue; // 名字压根没登记过 → 是真的无建联，不进这张表
        const cur = (input.currency || "USD").toUpperCase();
        const rate = exchangeRates.get(cur) ?? (cur === "USD" ? 1 : 0);
        const key = `${input.country}|${norm}`;
        let m = missMap.get(key);
        if (!m) {
          m = { upload_country: input.country, account_name: raw, rows: 0, gmv_usd: 0, registered: owners };
          missMap.set(key, m);
        }
        m.rows += agg.rows_count || 1;
        if (rate) m.gmv_usd += input.grossRevenue / rate;
      }
      const rowsOut = Array.from(missMap.values()).sort((a, b) => b.gmv_usd - a.gmv_usd);
      return json({ month, rows: rowsOut });
    }

    throw new Error(`未知 action: ${action}`);
  } catch (e) {
    const err = e as Error & { status?: number; payload?: Record<string, unknown> };
    const status = err.status ?? 400;
    console.error("attribution-upload", e);
    return new Response(JSON.stringify({ error: err.message, ...(err.payload ?? {}) }), {
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
