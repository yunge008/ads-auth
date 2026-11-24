// GMV Max exclusive authorization for the advertiser's TikTok Shop.
// Body: { advertiser_id, action?: "check" | "grant" }
//   check (default, read-only): /gmv_max/store/list/ → who holds exclusive authorization now.
//   grant (WRITE): /gmv_max/exclusive_authorization/create/ → give this advertiser exclusive
//     GMV Max authorization for its shop. Per TikTok docs the previous advertiser loses access and
//     ALL its GMV Max campaigns on that shop are paused automatically. Frontend must confirm first.
// store_id comes from advertiser_countries.shop_id; store_authorized_bc_id from tiktok_connections.bc_id
// (same source as gmv-max-adgroup-batch-create).
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttGet, ttPost } from "../_shared/tiktok.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "gmv-max-create");
    const body = (await req.json().catch(() => ({}))) as { advertiser_id?: unknown; action?: unknown };
    const advertiserId = String(body.advertiser_id ?? "").trim();
    if (!/^\d+$/.test(advertiserId)) throw new Error("advertiser_id 必填，且只能是数字");
    const action = body.action === "grant" ? "grant" : "check";

    const db = admin();
    const [{ data: shopRow, error: shopErr }, { data: connRows, error: connErr }] = await Promise.all([
      db.from("advertiser_countries").select("shop_id").eq("advertiser_id", advertiserId).maybeSingle(),
      db.from("tiktok_connections").select("access_token, advertiser_ids, bc_id").contains("advertiser_ids", [advertiserId]),
    ]);
    if (shopErr) throw new Error(shopErr.message);
    if (connErr) throw new Error(connErr.message);
    const storeId = (shopRow?.shop_id as string | null) ?? null;
    const conns = (connRows ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids" | "bc_id">[];
    if (!conns.length) throw new Error(`广告户 ${advertiserId} 没有可用的 TikTok 授权`);
    const bcId = conns.find((c) => c.bc_id)?.bc_id ?? null;

    const storeList = async (token: string) => {
      const data = await ttGet(token, "/gmv_max/store/list/", { advertiser_id: advertiserId });
      const list = (data.store_list ?? data.list ?? []) as Record<string, unknown>[];
      const store = storeId ? list.find((s) => String(s.store_id ?? "") === storeId) : undefined;
      const holder = (store?.exclusive_authorized_advertiser_info ?? null) as Record<string, unknown> | null;
      return {
        store_id: storeId,
        store_found: !!store,
        is_gmv_max_available: store?.is_gmv_max_available ?? null,
        holder_advertiser_id: holder?.advertiser_id != null ? String(holder.advertiser_id) : null,
        holder_advertiser_name: holder?.advertiser_name != null ? String(holder.advertiser_name) : null,
        raw: data,
      };
    };

    let lastErr: Error | null = null;
    for (const c of conns) {
      try {
        if (action === "check") return json({ action, ...(await storeList(c.access_token)) });
        if (!storeId) throw new Error(`广告户 ${advertiserId} 未配置店铺 ID（设置页 → 店铺ID）`);
        if (!bcId) throw new Error(`广告户 ${advertiserId} 找不到 BC ID`);
        const granted = await ttPost(c.access_token, "/gmv_max/exclusive_authorization/create/", {
          advertiser_id: advertiserId,
          store_id: storeId,
          store_authorized_bc_id: bcId,
        });
        const after = await storeList(c.access_token).catch((e) => ({ error: (e as Error).message }));
        return json({ action, granted, after });
      } catch (e) {
        lastErr = e as Error;
        if (!/40001|permission/i.test(lastErr.message)) break;
      }
    }
    throw lastErr ?? new Error("调用失败");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
