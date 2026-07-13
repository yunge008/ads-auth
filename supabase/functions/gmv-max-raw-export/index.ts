// Read-only GMV Max CSV export. It never writes or deletes report data.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { ttGet } from "../_shared/tiktok.ts";
import { fetchCampaigns, fetchReport } from "../_shared/gmv-max-report.ts";

const MAX_DAYS = 31;
const MAX_ROWS = 10000;
const CREATIVE_DIMENSIONS = ["campaign_id", "item_group_id", "item_id", "stat_time_day"];

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}
function daysBetween(start: string, end: string) {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000) + 1;
}
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function csvCell(value: unknown): string {
  const raw = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
function csvFileName(advertiserId: string, start: string, end: string) {
  return `gmv-max-${advertiserId}-${start}_${end}.csv`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "material-performance");
    const body = await req.json().catch(() => ({})) as { advertiser_id?: unknown; start_date?: unknown; end_date?: unknown };
    const advertiserId = String(body.advertiser_id ?? "").trim();
    const startDate = body.start_date;
    const endDate = body.end_date;
    if (!advertiserId) throw new Error("advertiser_id 必填");
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) throw new Error("start_date / end_date 必须为有效 YYYY-MM-DD，且起始日期不得晚于结束日期");
    if (daysBetween(startDate, endDate) > MAX_DAYS) throw new Error(`单次最多导出 ${MAX_DAYS} 天；请缩小日期范围后重试`);

    const db = admin();
    const [{ data: connections, error: connectionError }, { data: advertiser, error: advertiserError }] = await Promise.all([
      db.from("tiktok_connections").select("access_token, advertiser_ids"),
      db.from("advertiser_countries").select("advertiser_id, advertiser_name, country, shop_id").eq("advertiser_id", advertiserId).maybeSingle(),
    ]);
    if (connectionError) throw new Error(connectionError.message);
    if (advertiserError) throw new Error(advertiserError.message);
    if (!advertiser?.shop_id) throw new Error("该广告户未配置 shop_id，无法导出 GMV Max 数据");
    const conn = ((connections ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids">[]).find((item) => item.advertiser_ids.includes(advertiserId));
    if (!conn) throw new Error("该广告户没有可用的 TikTok 授权");

    const startedAt = Date.now();
    const ensureTime = () => {
      if (Date.now() - startedAt > 75000) throw new Error("导出接近函数时限，请缩小日期范围后重试");
    };
    const campaigns = await fetchCampaigns(conn.access_token, advertiserId, ttGet, ensureTime);
    const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
    const exported: Record<string, unknown>[] = [];

    for (const campaign of campaigns) {
      ensureTime();
      const groups = await fetchReport(
        conn.access_token, advertiserId, advertiser.shop_id, startDate, endDate,
        ["campaign_id", "item_group_id"], { campaign_ids: [campaign.id] }, undefined, ttGet, ensureTime,
      );
      const groupIds = Array.from(new Set(groups.map((row) => String((row.dimensions as Record<string, unknown> | undefined)?.item_group_id ?? "")).filter(Boolean)));
      for (const groupBatch of chunk(groupIds, 100)) {
        ensureTime();
        const reportRows = await fetchReport(
          conn.access_token, advertiserId, advertiser.shop_id, startDate, endDate,
          CREATIVE_DIMENSIONS, { campaign_ids: [campaign.id], item_group_ids: groupBatch }, undefined, ttGet, ensureTime,
        );
        for (const row of reportRows) {
          const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
          const metrics = (row.metrics ?? {}) as Record<string, unknown>;
          const rowCampaignId = String(dimensions.campaign_id ?? campaign.id);
          exported.push({
            advertiser_id: advertiserId,
            advertiser_name: advertiser.advertiser_name ?? "",
            country: advertiser.country ?? "",
            campaign_name: campaignById.get(rowCampaignId)?.name ?? "",
            campaign_operation_status: campaignById.get(rowCampaignId)?.operation_status ?? "",
            ...dimensions,
            ...metrics,
          });
          if (exported.length > MAX_ROWS) throw new Error(`结果超过 ${MAX_ROWS.toLocaleString()} 行；请缩小日期范围后重试`);
        }
      }
    }

    const preferred = ["advertiser_id", "advertiser_name", "country", "campaign_id", "campaign_name", "campaign_operation_status", "item_group_id", "item_id", "stat_time_day"];
    const keys = Array.from(new Set(exported.flatMap((row) => Object.keys(row))));
    const headers = [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key)).sort()];
    const csv = `\uFEFF${headers.join(",")}\r\n${exported.map((row) => headers.map((key) => csvCell(row[key])).join(",")).join("\r\n")}`;
    const fileName = csvFileName(advertiserId, startDate, endDate);
    return new Response(csv, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Export-Row-Count": String(exported.length),
      },
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});