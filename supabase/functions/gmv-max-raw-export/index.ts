// Read-only GMV Max export by date range. It never writes or deletes report data.
//
// 两种用法：
// - format:"json"（推荐，前端用）：分片续跑。首次不带 cursor，返回 {rows, next_cursor, campaign_totals...}；
//   next_cursor 非空就原样带回再调，直到为 null。任意大的广告户都能导完整。
// - 默认 / format:"csv"：单次请求内循环跑完所有分片后直接返回 CSV；
//   数据量太大跑不完会报错，提示改用 json 分片模式。
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { ttGet } from "../_shared/tiktok.ts";
import { fetchCampaigns } from "../_shared/gmv-max-report.ts";
import {
  buildCsv, daysInclusive, MAX_EXPORT_DAYS, runExportChunk, validateCursor, validDate,
} from "../_shared/gmv-max-export.ts";

// Supabase Edge Function 请求上限约 150s；软线后不再开新单元，硬线强制中断。
const CHUNK_SOFT_MS = 50_000;
const CHUNK_HARD_MS = 100_000;
const CSV_HARD_MS = 110_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const startedAt = Date.now();
  try {
    await checkAdminPasscode(req, "material-performance");
    const body = await req.json().catch(() => ({})) as {
      advertiser_id?: unknown; start_date?: unknown; end_date?: unknown; cursor?: unknown; format?: unknown;
    };
    const advertiserId = String(body.advertiser_id ?? "").trim();
    const startDate = body.start_date;
    const endDate = body.end_date;
    const format = body.format === "json" ? "json" : "csv";
    if (!/^\d+$/.test(advertiserId)) throw new Error("advertiser_id 必填，且只能是数字");
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
      throw new Error("start_date / end_date 必须为有效 YYYY-MM-DD，且起始日期不得晚于结束日期");
    }
    if (daysInclusive(startDate, endDate) > MAX_EXPORT_DAYS) {
      throw new Error(`单次最多导出 ${MAX_EXPORT_DAYS} 天；请缩小日期范围后重试`);
    }
    const cursor = validateCursor(body.cursor);
    if (cursor && format !== "json") throw new Error("cursor 只能和 format:\"json\" 一起使用");

    const db = admin();
    const [{ data: connections, error: connectionError }, { data: advertiser, error: advertiserError }] = await Promise.all([
      db.from("tiktok_connections").select("access_token, advertiser_ids").contains("advertiser_ids", [advertiserId]),
      db.from("advertiser_countries").select("advertiser_id, advertiser_name, country, shop_id").eq("advertiser_id", advertiserId).maybeSingle(),
    ]);
    if (connectionError) throw new Error(connectionError.message);
    if (advertiserError) throw new Error(advertiserError.message);
    if (!advertiser?.shop_id) throw new Error("该广告户未配置 shop_id，无法导出 GMV Max 数据");
    const conns = (connections ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids">[];
    if (!conns.length) throw new Error("该广告户没有可用的 TikTok 授权");

    // 同一广告户可能有多条授权，旧 token 失效时逐个尝试，取第一个能读 campaign 的。
    let token = "";
    let lastError: Error | null = null;
    for (const conn of conns) {
      try {
        await fetchCampaigns(conn.access_token, advertiserId, ttGet);
        token = conn.access_token;
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }
    if (!token) throw new Error(`该广告户的 ${conns.length} 条授权都无法读取 GMV Max 数据：${lastError?.message ?? "未知错误"}`);

    const base = {
      token, advertiserId, storeId: String(advertiser.shop_id),
      advertiserName: String(advertiser.advertiser_name ?? ""), country: String(advertiser.country ?? ""),
      startDate, endDate,
    };

    if (format === "json") {
      const result = await runExportChunk({
        ...base, cursor,
        softDeadline: startedAt + CHUNK_SOFT_MS,
        hardDeadline: startedAt + CHUNK_HARD_MS,
      });
      return json(result);
    }

    const result = await runExportChunk({
      ...base, cursor: null,
      softDeadline: startedAt + CSV_HARD_MS,
      hardDeadline: startedAt + CSV_HARD_MS,
    });
    if (result.next_cursor) {
      throw new Error("数据量较大，单次请求内导不完；请改用 format:\"json\" 分片模式（API 测试页的导出按钮已自动分片）");
    }
    if (result.errors.length) {
      throw new Error(`导出不完整，共 ${result.errors.length} 处失败：${result.errors.slice(0, 3).join("；")}`);
    }
    const rows = result.rows;
    return new Response(buildCsv(rows), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="gmv-max-${advertiserId}-${startDate}_${endDate}.csv"`,
        "X-Export-Row-Count": String(rows.length),
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
