// Shared TikTok GMV Max report reader.  Keeps pagination, invalid-metric fallback,
// rate limiting and retry behavior in the common ttGet client.
import { ttGet, type TimeBudgetChecker } from "./tiktok.ts";

export type RawRow = Record<string, unknown>;
export type CampaignInfo = { id: string; name: string; operation_status: string };

export async function fetchCampaigns(
  token: string,
  advertiserId: string,
  get: typeof ttGet = ttGet,
  ensureTime?: TimeBudgetChecker,
): Promise<CampaignInfo[]> {
  const out: CampaignInfo[] = [];
  const seen = new Set<string>();
  const filtering = JSON.stringify({ gmv_max_promotion_types: ["PRODUCT_GMV_MAX"] });
  for (let page = 1; page <= 50; page++) {
    ensureTime?.();
    const data = await get(token, "/gmv_max/campaign/get/", {
      advertiser_id: advertiserId, filtering, page: String(page), page_size: "100",
    }, undefined, undefined, ensureTime);
    const list = (data.list ?? []) as Array<Record<string, unknown>>;
    for (const row of list) {
      const id = String(row.campaign_id ?? row.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: String(row.campaign_name ?? row.name ?? ""), operation_status: String(row.operation_status ?? "") });
    }
    const info = (data.page_info ?? {}) as Record<string, unknown>;
    const totalPage = Number(info.total_page ?? 0);
    const total = Number(info.total_number ?? 0);
    if (!list.length || (totalPage > 0 && page >= totalPage) || (!totalPage && total > 0 && page * 100 >= total)) break;
  }
  return out;
}

export async function fetchReport(
  token: string,
  advertiserId: string,
  storeId: string,
  start: string,
  end: string,
  dimensions: string[],
  extraFilter: Record<string, unknown> = {},
  metrics?: string[],
  get: typeof ttGet = ttGet,
  ensureTime?: TimeBudgetChecker,
): Promise<RawRow[]> {
  const out: RawRow[] = [];
  const seen = new Set<string>();
  const defaultMetrics = dimensions.includes("item_id")
    ? ["creative_delivery_status", "cost", "orders", "gross_revenue", "product_impressions", "product_clicks", "currency", "tt_account_name", "tt_account_authorization_type", "shop_content_type", "ad_video_view_rate_2s", "ad_video_view_rate_6s", "ad_video_view_rate_p25", "ad_video_view_rate_p50", "ad_video_view_rate_p75", "ad_video_view_rate_p100"]
    : ["cost", "orders", "gross_revenue"];
  let activeMetrics = [...(metrics ?? defaultMetrics)];
  const filtering = JSON.stringify(extraFilter);
  for (let page = 1; page <= 100; page++) {
    ensureTime?.();
    const params: Record<string, string> = {
      advertiser_id: advertiserId, store_ids: JSON.stringify([storeId]), dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify(activeMetrics), start_date: start, end_date: end,
      page: String(page), page_size: "1000", filtering,
    };
    let data: Record<string, unknown>;
    try {
      data = await get(token, "/gmv_max/report/get/", params, undefined, undefined, ensureTime);
    } catch (error) {
      const match = ((error as Error).message ?? "").match(/Invalid metric\(s\):\s*'\[([^\]]+)\]'/);
      if (!match) throw error;
      const invalid = match[1].split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
      const next = activeMetrics.filter((metric) => !invalid.includes(metric));
      if (!next.length || next.length === activeMetrics.length) throw error;
      activeMetrics = next;
      page--;
      continue;
    }
    const list = (data.list ?? []) as RawRow[];
    for (const row of list) {
      const key = JSON.stringify((row.dimensions ?? row) as Record<string, unknown>);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    const info = (data.page_info ?? {}) as Record<string, unknown>;
    const totalPage = Number(info.total_page ?? 0);
    const total = Number(info.total_number ?? 0);
    if (!list.length || (totalPage > 0 && page >= totalPage) || (!totalPage && total > 0 && page * 1000 >= total)) break;
  }
  return out;
}