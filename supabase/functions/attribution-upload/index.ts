// Excel 广告表上传 + 归因。文件名约定「站点 MAX yyyymm.xlsx」→ 每文件一个批次。
// Body: { action: 'create'|'append'|'finalize'|'list'|'get'|'delete', ... }
//   create   { file_name, country, month:'YYYY-MM', note?, force? } → { upload_id }
//   append   { upload_id, rows: ParsedRow[] } （≤2000 行/批，幂等键 (upload_id,row_no)）
//   finalize { upload_id } → 归因 + 回填 attr_* + 汇总 → { summary }
//   list     { month? } → { uploads }
//   get      { upload_id, detail_for? } 或 { month, merged:true } → { summary, uploads?, detail_rows? }
//   delete   { upload_id }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, verifyPasscode } from "../_shared/auth.ts";
import {
  type AttrInputRow,
  type AttrRowResult,
  attributeRows,
  normalizeCreativeType,
  vidToPostedAt,
} from "../_shared/attribution.ts";
import {
  aggregateResults,
  loadAttrContext,
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

function toInput(uploadId: string, country: string, r: StoredRow): AttrInputRow {
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
      const rows = await fetchAllRows(db, uploadId);
      if (!rows.length) throw new Error("该批次没有数据行");

      const inputs = rows.map((r) => toInput(uploadId, upload.country, r));
      const ctx = await loadAttrContext(db);
      const run = attributeRows(inputs, ctx);
      const persisted = await persistRunArtifacts(db, run);
      const resultByKey = new Map(run.rows.map((r) => [r.key, r]));

      // 回填 attr_* 列（upsert 携带原列值，幂等）
      const writeback = rows.map((r) => {
        const res = resultByKey.get(`u:${uploadId}:${r.row_no}`)!;
        return {
          upload_id: uploadId,
          ...r,
          attr_bucket: res.bucket,
          attr_staff: res.staff ?? null,
          attr_source: res.source ?? null,
          attr_match_type: res.matchType ?? null,
        };
      });
      for (let i = 0; i < writeback.length; i += 500) {
        const { error } = await db.from("ad_upload_rows").upsert(writeback.slice(i, i + 500), { onConflict: "upload_id,row_no" });
        if (error) throw new Error(error.message);
      }

      const pairs = inputs.map((input) => ({ input, result: resultByKey.get(input.key)! }));
      const [targets, staffMeta] = await Promise.all([loadTargets(db, upload.month), loadStaffMeta(db)]);
      const summary = aggregateResults(pairs, {
        period: { start: upload.period_start ?? "", end: upload.period_end ?? "" },
        month: upload.month,
        targets,
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
      let q = db
        .from("ad_uploads")
        .select("id, file_name, country, month, uploaded_by, period_start, period_end, row_count, total_cost, total_revenue, status, attributed_at, note, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
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
          .select("id, file_name, country, month, period_start, period_end, status, row_count, total_revenue")
          .eq("month", month)
          .eq("status", "READY");
        if (error) throw new Error(error.message);
        const uploads = (ups ?? []) as (UploadRec & { row_count: number; total_revenue: number })[];
        if (!uploads.length) throw new Error(`没有 ${month} 已完成归因的上传批次`);
        const allPairs: ReturnType<typeof storedPairs> = [];
        for (const u of uploads) {
          const rows = await fetchAllRows(db, u.id);
          allPairs.push(...storedPairs(u.id, u.country, rows));
        }
        const [targets, staffMeta] = await Promise.all([loadTargets(db, month), loadStaffMeta(db)]);
        const { start, end } = monthRange(month);
        const summary = aggregateResults(allPairs, { period: { start, end }, month, targets, staffMeta });
        return json({
          summary,
          uploads,
          detail_rows: detailFor ? detailFromPairs(allPairs, detailFor) : undefined,
        });
      }
      const uploadId = str(body.upload_id);
      const upload = await getUpload(db, uploadId);
      const rows = await fetchAllRows(db, uploadId);
      const pairs = storedPairs(uploadId, upload.country, rows);
      const [targets, staffMeta] = await Promise.all([loadTargets(db, upload.month), loadStaffMeta(db)]);
      const summary = aggregateResults(pairs, {
        period: { start: upload.period_start ?? "", end: upload.period_end ?? "" },
        month: upload.month,
        targets,
        staffMeta,
      });
      return json({
        summary,
        upload,
        detail_rows: detailFor ? detailFromPairs(pairs, detailFor) : undefined,
      });
    }

    if (action === "delete") {
      const uploadId = str(body.upload_id);
      if (!uploadId) throw new Error("upload_id 必填");
      const { error } = await db.from("ad_uploads").delete().eq("id", uploadId);
      if (error) throw new Error(error.message);
      return json({ deleted: true });
    }

    throw new Error(`未知 action: ${action}`);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("attribution-upload", e);
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
