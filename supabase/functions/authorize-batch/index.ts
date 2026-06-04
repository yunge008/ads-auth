// Batch authorize TikTok BC materials.
// Body: { items: [{id, advertiser_id, auth_code, vid}] }
// Returns: { results: [{id, status, error_message?}] }
//
// Uses TikTok Business Center "creator authorization redeem" API.
// Endpoint path may differ per BC version — adjust below if needed.

import { corsHeaders } from "../_shared/feishu.ts";

const TT_BASE = "https://business-api.tiktok.com/open_api/v1.3";

type Item = {
  id: string;
  advertiser_id: string;
  auth_code: string;
  vid?: string;
};

async function authorizeOne(token: string, item: Item) {
  // TikTok BC API: Apply spark ads / TTCM authorization with redemption code.
  // Endpoint: /tt_video/authorize/  (POST)  — body shape per official docs.
  const res = await fetch(`${TT_BASE}/tt_video/authorize/`, {
    method: "POST",
    headers: {
      "Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      advertiser_id: item.advertiser_id,
      auth_code: item.auth_code,
    }),
  });
  const json = await res.json().catch(() => ({}));
  // TikTok returns { code: 0, message: "OK", data: {...} } on success
  if (json.code === 0) return { id: item.id, status: "已授权" as const };

  const msg = String(json.message ?? `HTTP ${res.status}`);
  const mapped = mapErrorToStatus(msg, json.code);
  return { id: item.id, status: mapped, error_message: msg };
}

function mapErrorToStatus(msg: string, _code?: number) {
  const m = msg.toLowerCase();
  if (m.includes("expire")) return "代码过期" as const;
  if (m.includes("delete") || m.includes("not exist") || m.includes("not found"))
    return "代码删除" as const;
  if (m.includes("invalid") || m.includes("incorrect")) return "代码有误" as const;
  if (m.includes("multi") || m.includes("multiple")) return "代码涉及多素材" as const;
  return "API错误" as const;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const token = Deno.env.get("TIKTOK_BC_ACCESS_TOKEN");
    if (!token) throw new Error("TIKTOK_BC_ACCESS_TOKEN 未配置");

    const { items } = (await req.json()) as { items: Item[] };
    if (!items?.length) throw new Error("items 不能为空");

    // Limited concurrency to avoid rate limits.
    const results: Array<{ id: string; status: string; error_message?: string }> = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const slice = items.slice(i, i + CONCURRENCY);
      const part = await Promise.all(
        slice.map((it) =>
          authorizeOne(token, it).catch((e) => ({
            id: it.id,
            status: "API错误" as const,
            error_message: (e as Error).message,
          })),
        ),
      );
      results.push(...part);
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("authorize-batch error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
