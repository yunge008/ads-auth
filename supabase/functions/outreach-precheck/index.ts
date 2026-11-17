// 外联发送前预检（规则 §2 冷却 + §3.4 保护期），系统群发 / 定向 / 插件群发都先调这里。
// Body: { site? | shop_id?, bd?: string（默认当前登录账号）, date?: YYYY-MM-DD（默认北京时间今天）, creators: [{ username?, open_id? }] }
// 返回逐个达人：allowed、reason、tag（§8.1 归属标签）、owner、protect_until、cooldown_until。只读。
import { corsHeaders } from "../_shared/feishu.ts";
import { verifyPasscode } from "../_shared/auth.ts";
import { bjDate, canTouch, computeState, sitePool } from "../_shared/ownership.ts";
import { type CreatorRef, loadInputs, loadSettings, poolOfShop } from "../_shared/outreach.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const acc = await verifyPasscode(req, "outreach");
    const b = (await req.json().catch(() => ({}))) as { site?: string; shop_id?: string; bd?: string; date?: string; creators?: CreatorRef[] };
    const pool = b.site ? sitePool(b.site) : b.shop_id ? await poolOfShop(String(b.shop_id)) : "";
    if (!pool) throw new Error("site 或 shop_id 必填");
    const creators = (b.creators ?? []).filter((c) => c && (c.username || c.open_id)).slice(0, 500);
    if (!creators.length) throw new Error("creators 不能为空（每次最多 500 个）");
    // 非管理员只能替自己预检
    const bd = acc.isAdmin && b.bd ? String(b.bd) : acc.name;
    const today = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : bjDate(Date.now());
    const [settings, inputs] = await Promise.all([loadSettings(), loadInputs(pool, creators)]);
    const results = creators.map((c, i) => {
      const st = computeState(inputs[i], today, settings);
      const chk = canTouch(st, bd, today, settings);
      return {
        username: c.username ?? null, open_id: c.open_id ?? null, allowed: chk.allowed, reason: chk.reason, tag: st.tag,
        owner: st.owner, protect_until: st.protectUntil, cooldown_until: st.cooldownUntil, last_touch: st.lastTouch,
      };
    });
    return json({ site_pool: pool, bd, date: today, allowed: results.filter((r) => r.allowed).length, blocked: results.filter((r) => !r.allowed).length, results });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
