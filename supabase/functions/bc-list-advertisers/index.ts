// List authorized advertisers under a TikTok Business Center.
// Returns: { advertisers: [{advertiser_id, advertiser_name, status}] }

import { corsHeaders } from "../_shared/feishu.ts";

const TT_BASE = "https://business-api.tiktok.com/open_api/v1.3";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const token = Deno.env.get("TIKTOK_BC_ACCESS_TOKEN");
    const bcId = Deno.env.get("TIKTOK_BC_ID");
    if (!token) throw new Error("TIKTOK_BC_ACCESS_TOKEN 未配置");
    if (!bcId) throw new Error("TIKTOK_BC_ID 未配置");

    const all: Array<{ advertiser_id: string; advertiser_name: string; status?: string }> = [];
    let page = 1;
    const pageSize = 50;
    // Hard cap to avoid runaway loops
    for (let i = 0; i < 50; i++) {
      const url = new URL(`${TT_BASE}/bc/advertiser/get/`);
      url.searchParams.set("bc_id", bcId);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(pageSize));
      const res = await fetch(url.toString(), {
        headers: { "Access-Token": token, "Content-Type": "application/json" },
      });
      const json = await res.json().catch(() => ({}));
      if (json.code !== 0) {
        throw new Error(`TikTok BC API 错误: ${json.message ?? `HTTP ${res.status}`}`);
      }
      const list = (json.data?.list ?? []) as Array<Record<string, unknown>>;
      for (const it of list) {
        const id = String(it.advertiser_id ?? "");
        if (!id) continue;
        all.push({
          advertiser_id: id,
          advertiser_name: String(it.advertiser_name ?? id),
          status: it.status ? String(it.status) : undefined,
        });
      }
      const total = Number(json.data?.page_info?.total_number ?? all.length);
      if (all.length >= total || list.length < pageSize) break;
      page += 1;
    }

    return new Response(JSON.stringify({ advertisers: all }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bc-list-advertisers error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
