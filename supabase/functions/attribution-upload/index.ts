// Excel 广告表上传 + 归因。文件名约定「站点 MAX yyyymm.xlsx」→ 每文件一个批次。
// Body: { action: 'create'|'append'|'finalize'|'list'|'get'|'delete'|'list_exchange_rates'|'save_exchange_rate'|'export_vid_summary', ... }
//   create   { file_name, country, month:'YYYY-MM', note?, force?, replace_existing? } → { upload_id }
//            同 (country, month) 已有 UPLOADING/READY 记录时默认报错（payload.duplicate=true）；replace_existing=true 先删旧记录再插入
//   append   { upload_id, rows: ParsedRow[] } （≤2000 行/批，幂等键 (upload_id,row_no)）
//   finalize { upload_id } → 校验汇率覆盖（缺失时报错 payload.missing_currencies=[...]，不写 attr_*/READY）→ 归因 + 回填 attr_* + 汇总 → { summary }
//   list     { month? } → { uploads }
//   get      { upload_id, detail_for? } 或 { month, merged:true } → { summary, uploads?, last_synced_at?, detail_rows? }
//   delete   { upload_id } 或 { upload_ids: [...] } 或 { all: true }（清空全部批次，级联删行）
//   diagnose      { month, sample_limit? } → 归因口径自查：逐批次统计商品卡/VID命中/昵称同站点命中/昵称异站点/从未登记，
//                 并给出「哪一层断了」的结论，用于排查「一个人都归不上」
//   site_mismatch { month } → { rows }：站点按字母精确匹配后仍归 UNMATCHED、但达人名字在建联归属/别名表里
//                 存在（只是登记在别的站点）的行，按 (上传站点, 达人昵称) 聚合，供人工确认是否该跨站点认人
//   list_exchange_rates {} → { rates }（含禁用行）
//   save_exchange_rate  { currency, usd_rate, enabled? } → { rate }；usd_rate 语义=1 美元兑多少本币
//   export_vid_summary  { month } → { rows }：按 (国家,VID,商品ID) 聚合的唯一 VID 汇总（14 列口径），前端生成 xlsx
//   unmatched_trend     { month } → { months, rows }：以 month 为最近一个月，往前推 12 个月，逐月在 DB 内按 (国家,达人昵称) 聚合 UNMATCHED 桶 GMV（折美元），再合并 rows[].by_month；避免 12 个月单条 SQL 撞 statement timeout
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, verifyPasscode } from "../_shared/auth.ts";
import {
  type AttrInputRow,
  type AttrRowResult,
  attributeRows,
  identityKey,
  normalizeCreativeType,
  normalizeName,
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

type StoredRow = {
  row_no: number;
  campaign_name: string | null;
  campaign_id: string;
  product_id: string;
  creative_type: string;
  video_title: string | null;
  vid: string;
  tt_account_name: string;
  posted_at: string | null;
  status: string | null;
  authorization_type: string | null;
  cost: number;
  orders: number;
  gross_revenue: number;
  roi: number | null;
  impressions: number | null;
  clicks: number | null;
  currency: string | null;
  attr_bucket: string | null;
  attr_staff: string | null;
  attr_source: string | null;
  attr_match_type: string | null;
};

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

function toInput(uploadId: string, country: string, r: AttrRow): AttrInputRow {
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
    key: `u:${uploadId}:${r.row_no}`,
    creativeType: normalizeCreativeType(r.creative_type),
    vid: r.vid ?? "",
    accountName: r.tt_account_name ?? "",
    country,
    postedAt,
    postedAtSource,
    currency: r.currency ?? "USD",
    cost: num(r.cost),
    grossRevenue: num(r.gross_revenue),
    orders: Math.round(num(r.orders)),
  };
}

/** 从已存储的 attr_* 列重建归因结果（get / merged 视图不重跑引擎）。 */
function storedPairs(uploadId: string, country: string, rows: StoredRow[]) {
  return rows.map((r) => {
    const input = toInput(uploadId, country, r);
    const result: AttrRowResult = {
      key: input.key,
      bucket: (r.attr_bucket as AttrRowResult["bucket"]) ?? "UNMATCHED",
      staff: r.attr_staff ?? undefined,
      source: (r.attr_source as AttrRowResult["source"]) ?? undefined,
      matchType: (r.attr_match_type as AttrRowResult["matchType"]) ?? undefined,
      country,
    };
    return { input, result, stored: r };
  });
}

/** 归因只需要这 9 列；finalize 读全部 22 列在 10 万行量级会明显拖慢并推高内存。 */
const ATTR_COLUMNS = "row_no, creative_type, vid, tt_account_name, posted_at, cost, orders, gross_revenue, currency";

type AttrRow = Pick<
  StoredRow,
  "row_no" | "creative_type" | "vid" | "tt_account_name" | "posted_at" | "cost" | "orders" | "gross_revenue" | "currency"
>;

/** finalize 专用：只取归因需要的列，分页拉全量。 */
async function fetchAttrRows(db: ReturnType<typeof admin>, uploadId: string): Promise<AttrRow[]> {
  const out: AttrRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("ad_upload_rows")
      .select(ATTR_COLUMNS)
      .eq("upload_id", uploadId)
      .order("row_no", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as AttrRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function fetchAllRows(db: ReturnType<typeof admin>, uploadId: string): Promise<StoredRow[]> {
  const out: StoredRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("ad_upload_rows")
      .select(
        "row_no, campaign_name, campaign_id, product_id, creative_type, video_title, vid, tt_account_name, posted_at, status, authorization_type, cost, orders, gross_revenue, roi, impressions, clicks, currency, attr_bucket, attr_staff, attr_source, attr_match_type",
      )
      .eq("upload_id", uploadId)
      .order("row_no", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as StoredRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
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

type UnmatchedRow = { tt_account_name: string; gross_revenue: number; currency: string | null };

/**
 * 只取某批次 UNMATCHED 桶的 3 个字段。
 * `unmatched_trend` 要扫 12 个月 × 全部站点的批次，走 fetchAllRows（22 列 + 全部桶）会超时，
 * 这里把桶过滤下推到数据库、列裁到最小。
 */
async function fetchUnmatchedRows(db: ReturnType<typeof admin>, uploadId: string): Promise<UnmatchedRow[]> {
  const out: UnmatchedRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("ad_upload_rows")
      .select("tt_account_name, gross_revenue, currency")
      .eq("upload_id", uploadId)
      .eq("attr_bucket", "UNMATCHED")
      .order("row_no", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as UnmatchedRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
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

function detailFromPairs(
  pairs: Array<{ input: AttrInputRow; result: AttrRowResult; stored?: StoredRow }>,
  f: { staff?: string; role?: string; bucket?: string },
) {
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
    .map(({ input, result, stored }) => ({
      row_no: stored?.row_no,
      vid: input.vid,
      account_name: input.accountName,
      campaign_name: stored?.campaign_name ?? null,
      product_id: stored?.product_id ?? null,
      creative_type: input.creativeType,
      country: result.country,
      gmv: input.grossRevenue,
      cost: input.cost,
      orders: input.orders,
      currency: input.currency,
      bucket: result.bucket,
      staff: result.staff ?? null,
      source: result.source ?? null,
      match_type: result.matchType ?? null,
      posted_at: input.postedAt,
    }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const account = await verifyPasscode(req, "gmv-attribution-admin");
    const body = (await req.json()) as Record<string, unknown>;
    const action = str(body.action);
    const db = admin();

    if (action === "create") {
      const fileName = str(body.file_name);
      const country = str(body.country);
      const month = str(body.month);
      if (!fileName) throw new Error("file_name 必填");
      if (!country) throw new Error("country 必填（从文件名「站点 MAX yyyymm.xlsx」解析或手动指定）");
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
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

    if (action === "finalize") {
      const uploadId = str(body.upload_id);
      const upload = await getUpload(db, uploadId);
      const t0 = Date.now();
      const rows = await fetchAttrRows(db, uploadId);
      if (!rows.length) throw new Error("该批次没有数据行");
      console.log(`finalize ${uploadId}: 读取 ${rows.length} 行耗时 ${Date.now() - t0}ms`);

      const inputs = rows.map((r) => toInput(uploadId, upload.country, r));

      const exchangeRatesPre = await loadExchangeRates(db);
      const missing = findMissingCurrencies(inputs, exchangeRatesPre);
      if (missing.length) {
        throw errWithPayload(
          `缺少汇率配置：${missing.join("、")}，请先在设置页维护汇率后重试`,
          { missing_currencies: missing },
        );
      }

      const ctx = await loadAttrContext(db);
      const run = attributeRows(inputs, ctx);
      const persisted = await persistRunArtifacts(db, run);
      const resultByKey = new Map(run.rows.map((r) => [r.key, r]));

      // 回填 attr_* 列。只发「主键 + 4 个归因列」：这些行必然已存在，ON CONFLICT 只会更新带过来的列，
      // 不必把 22 列原样再传一遍——10 万行时那样的请求体会把 finalize 直接拖到超时（表现就是「卡在上传中」）。
      const writeback = rows.map((r) => {
        const res = resultByKey.get(`u:${uploadId}:${r.row_no}`)!;
        return {
          upload_id: uploadId,
          row_no: r.row_no,
          attr_bucket: res.bucket,
          attr_staff: res.staff ?? null,
          attr_source: res.source ?? null,
          attr_match_type: res.matchType ?? null,
        };
      });
      const t1 = Date.now();
      for (let i = 0; i < writeback.length; i += 1000) {
        const { error } = await db
          .from("ad_upload_rows")
          .upsert(writeback.slice(i, i + 1000), { onConflict: "upload_id,row_no" });
        if (error) throw new Error(error.message);
      }
      console.log(`finalize ${uploadId}: 回填 ${writeback.length} 行耗时 ${Date.now() - t1}ms`);

      const pairs = inputs.map((input) => ({ input, result: resultByKey.get(input.key)! }));
      const [targets, staffMeta] = await Promise.all([loadTargets(db, upload.month), loadStaffMeta(db)]);
      const summary = aggregateResults(pairs, {
        period: { start: upload.period_start ?? "", end: upload.period_end ?? "" },
        month: upload.month,
        targets,
        exchangeRates: exchangeRatesPre,
        staffMeta,
      });

      const { error: upErr } = await db
        .from("ad_uploads")
        .update({
          row_count: rows.length,
          total_cost: summary.totals.cost,
          total_revenue: summary.totals.gmv,
          status: "READY",
          attributed_at: new Date().toISOString(),
        })
        .eq("id", uploadId);
      if (upErr) throw new Error(upErr.message);

      return json({ summary, persisted, row_count: rows.length });
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
        const { data: ups, error } = await db
          .from("ad_uploads")
          .select("id, file_name, country, month, period_start, period_end, status, row_count, total_revenue, attributed_at")
          .eq("month", month)
          .eq("status", "READY");
        if (error) throw new Error(error.message);
        const uploads = (ups ?? []) as (UploadRec & { row_count: number; total_revenue: number; attributed_at: string | null })[];
        if (!uploads.length) {
          // 该月没有已完成归因的批次时，返回空报表而不是报错（避免前端白屏）
          const [targets0, exchangeRates0, staffMeta0] = await Promise.all([
            loadTargets(db, month),
            loadExchangeRates(db),
            loadStaffMeta(db),
          ]);
          const { start: s0, end: e0 } = monthRange(month);
          return json({
            summary: aggregateResults([], {
              period: { start: s0, end: e0 },
              month,
              targets: targets0,
              exchangeRates: exchangeRates0,
              staffMeta: staffMeta0,
            }),
            uploads: [],
            last_synced_at: null,
            detail_rows: detailFor ? [] : undefined,
          });
        }
        // 内存优化：整月合并可能有 10w+ 行，逐批次读取后立刻丢掉原始行（22 列），
        // 只保留聚合所需的 input/result；明细按批次先过滤再合并，避免 worker OOM。
        const allPairs: Array<{ input: AttrInputRow; result: AttrRowResult }> = [];
        let detailRows: ReturnType<typeof detailFromPairs> = [];
        for (const u of uploads) {
          const rows = await fetchAllRows(db, u.id);
          const pairs = storedPairs(u.id, u.country, rows);
          if (detailFor) {
            detailRows = detailRows
              .concat(detailFromPairs(pairs, detailFor))
              .sort((a, b) => b.gmv - a.gmv)
              .slice(0, DETAIL_CAP);
          }
          for (const p of pairs) allPairs.push({ input: p.input, result: p.result });
        }
        const [targets, exchangeRates, staffMeta] = await Promise.all([loadTargets(db, month), loadExchangeRates(db), loadStaffMeta(db)]);
        const { start, end } = monthRange(month);
        const summary = aggregateResults(allPairs, { period: { start, end }, month, targets, exchangeRates, staffMeta });
        const lastSyncedAt = uploads.reduce<string | null>(
          (acc, u) => (u.attributed_at && (!acc || u.attributed_at > acc) ? u.attributed_at : acc),
          null,
        );
        return json({
          summary,
          uploads,
          last_synced_at: lastSyncedAt,
          detail_rows: detailFor ? detailRows : undefined,
        });

      }
      const uploadId = str(body.upload_id);
      const upload = await getUpload(db, uploadId);
      const rows = await fetchAllRows(db, uploadId);
      const pairs = storedPairs(uploadId, upload.country, rows);
      const [targets, exchangeRates, staffMeta] = await Promise.all([loadTargets(db, upload.month), loadExchangeRates(db), loadStaffMeta(db)]);
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

    if (action === "export_vid_summary") {
      const month = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      const { data: ups, error } = await db
        .from("ad_uploads")
        .select("id, file_name, country, month, period_start, period_end, status")
        .eq("month", month)
        .eq("status", "READY");
      if (error) throw new Error(error.message);
      const uploads = (ups ?? []) as UploadRec[];
      if (!uploads.length) throw new Error(`没有 ${month} 已完成归因的上传批次`);

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
      const exchangeRates = await loadExchangeRates(db);

      for (const u of uploads) {
        const rows = await fetchAllRows(db, u.id);
        for (const r of rows) {
          const input = toInput(u.id, u.country, r);
          const cur = (input.currency || "USD").toUpperCase();
          const rate = exchangeRates.get(cur) ?? (cur === "USD" ? 1 : 0);
          if (!rate) continue; // 理论上不会发生：finalize 已强制要求补齐汇率
          const pid = r.product_id ?? "";
          const key = `${input.country}|${input.vid}|${pid}`;
          let g = groups.get(key);
          if (!g) {
            g = { country: input.country, vid: input.vid, product_id: pid, gmvUsd: 0, costUsd: 0, orders: 0, impressions: 0, clicks: 0, accountNameCounts: new Map() };
            groups.set(key, g);
          }
          g.gmvUsd += input.grossRevenue / rate;
          g.costUsd += input.cost / rate;
          g.orders += input.orders;
          g.impressions += r.impressions ?? 0;
          g.clicks += r.clicks ?? 0;
          const name = input.accountName.trim() || "（无账号）";
          g.accountNameCounts.set(name, (g.accountNameCounts.get(name) ?? 0) + 1);
        }
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
        if (g.accountNameCounts.size > 1) {
          console.log(`export_vid_summary: vid=${g.vid} 昵称不一致，取出现最多次的「${bestName}」，候选=${JSON.stringify(Array.from(g.accountNameCounts.entries()))}`);
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
      type TrendRow = { country: string; account_name: string; month: string; gmv_usd: number };
      type Agg = { country: string; account_name: string; byMonth: Map<string, number> };
      const aggMap = new Map<string, Agg>();
      // 12 个月一次性聚合在大月份会逼近数据库的语句超时；逐月执行可稳定利用 upload_id 部分索引。
      for (const trendMonth of months) {
        const { data, error } = await db.rpc("attribution_unmatched_trend_json", { _months: [trendMonth] });
        if (error) throw new Error(`${trendMonth}: ${error.message}`);
        for (const r of (Array.isArray(data) ? data : []) as TrendRow[]) {
          const key = `${r.country}|${r.account_name}`;
          let agg = aggMap.get(key);
          if (!agg) {
            agg = { country: r.country, account_name: r.account_name, byMonth: new Map() };
            aggMap.set(key, agg);
          }
          agg.byMonth.set(r.month, num(r.gmv_usd));
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
      // ad_upload_rows.upload_id 是 ON DELETE CASCADE，删批次会连行一起删
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
      const perUploadCap = Math.max(1000, Math.min(200000, Math.round(num(body.sample_limit)) || 50000));

      const { data: ups, error } = await db
        .from("ad_uploads")
        .select("id, file_name, country, month, status, row_count")
        .eq("month", month)
        .order("country", { ascending: true });
      if (error) throw new Error(error.message);
      const uploads = (ups ?? []) as Array<UploadRec & { row_count: number }>;

      const ctx = await loadAttrContext(db);

      // 名字（不分站点）→ 已登记站点集合，用于区分「名字没登记过」和「名字登记在别的站点」
      const sitesByName = new Map<string, Set<string>>();
      const addName = (key: string) => {
        const at = key.indexOf("\u001f");
        const country = at < 0 ? "" : key.slice(0, at);
        const norm = at < 0 ? key : key.slice(at + 1);
        if (!norm) return;
        const set = sitesByName.get(norm) ?? new Set<string>();
        set.add(country || "（空）");
        sitesByName.set(norm, set);
      };
      for (const k of ctx.ownership.keys()) addName(k);
      for (const k of ctx.manualAlias.keys()) addName(k);
      for (const k of ctx.vidAlias.keys()) addName(k);

      const registryCountries = new Map<string, number>();
      for (const k of ctx.ownership.keys()) {
        const at = k.indexOf("\u001f");
        const c = at < 0 ? "（空）" : (k.slice(0, at) || "（空）");
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
        sampled: boolean;
        product_card: number;
        vid_rows: number;
        vid_hit: number;
        no_name: number;
        name_hit_same_site: number;
        /** 名字登记过、但登记站点和上传站点不一致 → 归因引擎按规则判 UNMATCHED */
        name_hit_other_site: number;
        name_never_registered: number;
        /** 上述「站点对不上」的样本：上传站点 → 登记站点 */
        other_site_samples: Array<{ account_name: string; registered_sites: string[] }>;
      };
      const emptyLayer = (): Layer => ({
        rows: 0, sampled: false, product_card: 0, vid_rows: 0, vid_hit: 0, no_name: 0,
        name_hit_same_site: 0, name_hit_other_site: 0, name_never_registered: 0, other_site_samples: [],
      });
      const total = emptyLayer();

      const perUpload: Array<{ file_name: string; country: string; status: string } & Layer> = [];
      for (const u of uploads) {
        const layer = emptyLayer();
        let from = 0;
        for (; from < perUploadCap;) {
          const { data, error: rowErr } = await db
            .from("ad_upload_rows")
            .select("creative_type, vid, tt_account_name")
            .eq("upload_id", u.id)
            .order("row_no", { ascending: true })
            .range(from, Math.min(from + PAGE, perUploadCap) - 1);
          if (rowErr) throw new Error(rowErr.message);
          const rows = (data ?? []) as Array<{ creative_type: string; vid: string; tt_account_name: string }>;
          for (const r of rows) {
            layer.rows++;
            if (normalizeCreativeType(r.creative_type) === "product_card") {
              layer.product_card++;
              continue;
            }
            const vid = r.vid ?? "";
            if (vid) {
              layer.vid_rows++;
              if (ctx.vidRegs.has(vid)) {
                layer.vid_hit++;
                continue;
              }
            }
            const norm = normalizeName(r.tt_account_name);
            if (!norm) {
              layer.no_name++;
              continue;
            }
            const scoped = identityKey(u.country, norm);
            if (ctx.manualAlias.has(scoped) || ctx.ownership.has(scoped) || ctx.vidAlias.has(scoped)) {
              layer.name_hit_same_site++;
              continue;
            }
            const sites = sitesByName.get(norm);
            if (sites?.size) {
              layer.name_hit_other_site++;
              if (layer.other_site_samples.length < 10) {
                layer.other_site_samples.push({
                  account_name: (r.tt_account_name ?? "").trim(),
                  registered_sites: Array.from(sites).slice(0, 5),
                });
              }
            } else {
              layer.name_never_registered++;
            }
          }
          if (rows.length < PAGE) break;
          from += PAGE;
        }
        layer.sampled = layer.rows >= perUploadCap && (u.row_count ?? 0) > layer.rows;
        perUpload.push({ file_name: u.file_name, country: u.country, status: u.status, ...layer });
        total.rows += layer.rows;
        total.product_card += layer.product_card;
        total.vid_rows += layer.vid_rows;
        total.vid_hit += layer.vid_hit;
        total.no_name += layer.no_name;
        total.name_hit_same_site += layer.name_hit_same_site;
        total.name_hit_other_site += layer.name_hit_other_site;
        total.name_never_registered += layer.name_never_registered;
        total.sampled = total.sampled || layer.sampled;
      }

      // 结论：按归因瀑布从上往下，第一条断掉的就是主因
      const hints: string[] = [];
      if (!uploads.length) hints.push(`${month} 没有任何上传批次，先上传广告表。`);
      if (!ctx.vidRegs.size && !ctx.ownership.size) {
        hints.push("VID 登记表和建联归属表都是空的 —— 说明「同步达人登记」从来没成功跑过（或跑完被清空了）。先点「同步达人登记（建联+归档+剪辑）」，看返回的登记行数是否 > 0。");
      } else {
        if (!ctx.vidRegs.size) hints.push("VID 登记为空：staff_vid_map 与 creator_registry 都没有带 VID 的记录，VID 强匹配这一层完全失效。");
        if (!ctx.ownership.size) hints.push("建联归属为空：creator_ownership 没有记录，昵称匹配这一层完全失效。");
      }
      if (total.vid_rows > 0 && total.vid_hit === 0 && ctx.vidRegs.size > 0) {
        hints.push(`广告表里有 ${total.vid_rows} 行带 VID，但没有一个 VID 出现在登记表（登记表共 ${ctx.vidRegs.size} 个 VID）。检查飞书建联表 P 列 / 授权记录 Q 列 / 剪辑表 G 列的 VID 是否真的填了、是否 19 位且以 7 开头。`);
      }
      if (total.name_hit_other_site > 0 && total.name_hit_other_site >= total.name_hit_same_site) {
        const upSites = Array.from(new Set(uploads.map((u) => u.country))).join("、");
        const regSites = Array.from(registryCountries.keys()).slice(0, 15).join("、");
        hints.push(`有 ${total.name_hit_other_site} 行的达人名字在登记表里存在，但登记站点和上传站点对不上，按现行口径一律判「无建联」。上传站点写法：${upSites}；登记表站点写法：${regSites}。两边必须逐字一致（大小写和空格会自动归一，中英文不会）。`);
      }
      if (total.name_never_registered > 0 && total.name_hit_same_site === 0 && total.vid_hit === 0) {
        hints.push(`还有 ${total.name_never_registered} 行的达人名字在建联/别名表里完全查不到，这部分是真正的「无建联达人」。`);
      }
      if (!hints.length) hints.push("各层都有命中，归因口径本身没有断点。");

      return json({
        month,
        sample_limit: perUploadCap,
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
        hints,
      });
    }

    if (action === "site_mismatch") {
      const month = str(body.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month 格式应为 YYYY-MM");
      const { data: ups, error } = await db
        .from("ad_uploads")
        .select("id, country, month")
        .eq("month", month)
        .eq("status", "READY");
      if (error) throw new Error(error.message);
      const uploads = (ups ?? []) as { id: string; country: string; month: string }[];
      if (!uploads.length) throw new Error(`没有 ${month} 已完成归因的上传批次`);

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
      type Miss = {
        upload_country: string;
        account_name: string;
        rows: number;
        gmv_usd: number;
        registered: Owner[];
      };
      const missMap = new Map<string, Miss>();
      for (const u of uploads) {
        const rows = await fetchUnmatchedRows(db, u.id);
        for (const r of rows) {
          const raw = (r.tt_account_name ?? "").trim();
          const norm = normalizeName(raw);
          if (!norm) continue;
          const owners = byName.get(norm);
          if (!owners?.length) continue; // 名字压根没登记过 → 是真的无建联，不进这张表
          // 站点精确匹配得上的不会走到 UNMATCHED，这里剩下的都是「名字在、站点不同」
          const cur = (r.currency || "USD").toUpperCase();
          const rate = exchangeRates.get(cur) ?? (cur === "USD" ? 1 : 0);
          const key = `${u.country}|${norm}`;
          let m = missMap.get(key);
          if (!m) {
            m = { upload_country: u.country, account_name: raw, rows: 0, gmv_usd: 0, registered: owners };
            missMap.set(key, m);
          }
          m.rows++;
          if (rate) m.gmv_usd += num(r.gross_revenue) / rate;
        }
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
