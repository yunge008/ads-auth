// Aggregate advertisers across ALL stored TikTok connections.
// Returns: { advertisers: [{advertiser_id, advertiser_name, status?, label}] }
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api/v1.3";

type Info = Map<string, { name: string; status?: string }>;

async function callInfo(token: string, ids: string[]) {
  const u = new URL(`${TT}/advertiser/info/`);
  u.searchParams.set("advertiser_ids", JSON.stringify(ids));
  u.searchParams.set("fields", JSON.stringify(["advertiser_id", "name", "status", "company"]));
  const res = await fetch(u.toString(), { headers: { "Access-Token": token } });
  const j = await res.json().catch(() => ({}));
  const list = Array.isArray(j?.data?.list) ? j.data.list : Array.isArray(j?.data) ? j.data : [];
  return { code: Number(j?.code ?? -1), message: String(j?.message ?? `HTTP ${res.status}`), list: list as Array<Record<string, unknown>> };
}

// 整批报错（常见：批内某个户已删/无权限）时逐户重试，避免一个坏户让整条连接的户名全丢
async function enrich(token: string, ids: string[], errs: string[]): Promise<Info> {
  const out: Info = new Map();
  const put = (list: Array<Record<string, unknown>>) => {
    for (const it of list) {
      const id = String(it.advertiser_id ?? it.id ?? "");
      const name = String(it.advertiser_name ?? it.name ?? it.company ?? "").trim();
      if (id && name) out.set(id, { name, status: it.status ? String(it.status) : undefined });
    }
  };
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const r = await callInfo(token, batch);
    if (r.code === 0) { put(r.list); continue; }
    console.warn("advertiser/info batch failed", r.code, r.message);
    for (const id of batch) {
      const one = await callInfo(token, [id]);
      if (one.code === 0) put(one.list);
      else errs.push(`${id}: ${one.code} ${one.message}`.slice(0, 160));
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const { data: conns, error } = await admin()
      .from("tiktok_connections")
      .select("*");
    if (error) throw new Error(error.message);
    const rows = (conns ?? []) as ConnRow[];
    if (!rows.length) {
      return new Response(JSON.stringify({ advertisers: [], warning: "尚无 TikTok 连接，请先在设置页点「连接 TikTok」" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 所有连接都查一遍，任一连接拿到名字即用；都拿不到再用库里缓存名（advertiser_countries.advertiser_name）
    const names: Info = new Map();
    const labelOf = new Map<string, string>();
    const errors: string[] = [];
    for (const c of rows) {
      for (const id of c.advertiser_ids) if (!labelOf.has(id)) labelOf.set(id, c.label);
      try {
        const errs: string[] = [];
        const info = await enrich(c.access_token, c.advertiser_ids, errs);
        for (const [id, v] of info) if (!names.has(id)) names.set(id, v);
        if (errs.length) errors.push(`[${c.label}] ${errs.join("；")}`);
      } catch (e) {
        errors.push(`[${c.label}] ${(e as Error).message}`);
      }
    }
    const ids = Array.from(labelOf.keys());
    const db = admin();
    const { data: cached } = await db.from("advertiser_countries").select("advertiser_id,advertiser_name").in("advertiser_id", ids);
    const cachedName = new Map((cached ?? []).map((r: { advertiser_id: string; advertiser_name: string | null }) => [r.advertiser_id, r.advertiser_name]));
    // 接口拿到的新名字回写缓存（只更新已有行，不新建）
    for (const [id, v] of names) {
      if (cachedName.has(id) && cachedName.get(id) !== v.name) {
        const { error: ue } = await db.from("advertiser_countries").update({ advertiser_name: v.name }).eq("advertiser_id", id);
        if (ue) console.warn("cache advertiser_name", id, ue.message);
      }
    }
    const advertisers = ids.map((id) => ({
      advertiser_id: id,
      advertiser_name: names.get(id)?.name ?? cachedName.get(id) ?? id,
      status: names.get(id)?.status,
      label: labelOf.get(id)!,
    }));
    if (errors.length) console.warn("bc-list-advertisers errors", errors.join(" | ").slice(0, 2000));

    return new Response(
      JSON.stringify({ advertisers, errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("bc-list-advertisers", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
