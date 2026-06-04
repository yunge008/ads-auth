// Batch authorize. Looks up the right access_token by advertiser_id from tiktok_connections.
// Body: { items: [{id, advertiser_id, auth_code, vid?}] }
// Returns: { results: [{id, status, error_message?}] }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api/v1.3";

type Item = { id: string; advertiser_id: string; auth_code: string; vid?: string };

function mapErr(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes("expire")) return "代码过期" as const;
  if (m.includes("delete") || m.includes("not exist") || m.includes("not found"))
    return "代码删除" as const;
  if (m.includes("invalid") || m.includes("incorrect")) return "代码有误" as const;
  if (m.includes("multi") || m.includes("multiple")) return "代码涉及多素材" as const;
  return "API错误" as const;
}

async function authOne(token: string, it: Item, attempt = 0): Promise<{ id: string; status: string; error_message?: string }> {
  const encoded = it.auth_code.replace(/\+/g, "%2B");
  const res = await fetch(`${TT}/tt_video/authorize/`, {
    method: "POST",
    headers: { "Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ advertiser_id: it.advertiser_id, auth_code: encoded }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.code === 0) return { id: it.id, status: "已授权" as const };
  const msg = String(j.message ?? `HTTP ${res.status}`);
  if ((/too many requests|rate limit/i.test(msg) || res.status === 429) && attempt < 4) {
    const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
    await new Promise((r) => setTimeout(r, delay));
    return authOne(token, it, attempt + 1);
  }
  return { id: it.id, status: mapErr(msg), error_message: msg };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    checkAdminPasscode(req);
    const { items } = (await req.json()) as { items: Item[] };
    if (!items?.length) throw new Error("items 不能为空");

    const { data: conns, error } = await admin().from("tiktok_connections").select("*");
    if (error) throw new Error(error.message);
    const rows = (conns ?? []) as ConnRow[];

    // advertiser_id -> token (first match wins)
    const tokenByAdv = new Map<string, string>();
    for (const c of rows) {
      for (const id of c.advertiser_ids) {
        if (!tokenByAdv.has(id)) tokenByAdv.set(id, c.access_token);
      }
    }

    const results: Array<{ id: string; status: string; error_message?: string }> = [];
    const CONC = 4;
    for (let i = 0; i < items.length; i += CONC) {
      const slice = items.slice(i, i + CONC);
      const part = await Promise.all(
        slice.map((it) => {
          const tok = tokenByAdv.get(it.advertiser_id);
          if (!tok) {
            return Promise.resolve({
              id: it.id,
              status: "API错误" as const,
              error_message: `广告户 ${it.advertiser_id} 未在任何 TikTok 连接中找到，请重新授权`,
            });
          }
          return authOne(tok, it).catch((e) => ({
            id: it.id,
            status: "API错误" as const,
            error_message: (e as Error).message,
          }));
        }),
      );
      results.push(...part);
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("authorize-batch", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
