// 达人外联 A 线：数据库读写辅助（规则计算见 ownership.ts）。
import { admin } from "./auth.ts";
import { normalizeHandle } from "./tts.ts";
import { DEFAULT_SETTINGS, type Input, type OwnershipEvent, type Settings, sitePool, type Touch } from "./ownership.ts";

export type CreatorRef = { username?: string; open_id?: string; nickname?: string };
export const creatorKey = (c: CreatorRef) => (c.open_id ? String(c.open_id).trim() : normalizeHandle(c.username ?? ""));

export async function loadSettings(): Promise<Settings> {
  const { data, error } = await admin().from("outreach_settings").select("key,value");
  if (error) throw error;
  const m = new Map((data ?? []).map((r: { key: string; value: unknown }) => [r.key, Number(r.value)]));
  return {
    cooldownDays: m.get("cooldown_days") || DEFAULT_SETTINGS.cooldownDays,
    protectDays: m.get("protect_days") || DEFAULT_SETTINGS.protectDays,
    unrepliedTagDays: m.get("unreplied_tag_days") || DEFAULT_SETTINGS.unrepliedTagDays,
  };
}

/** §4 离职：staff_site_permissions.end_date 视为该站点的最后工作日 L（同站点池取最晚） */
export async function loadLastWorkdays(pool: string): Promise<Record<string, string>> {
  const { data, error } = await admin().from("staff_site_permissions").select("staff_name,country,end_date").not("end_date", "is", null);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as Array<{ staff_name: string; country: string; end_date: string }>) {
    if (sitePool(r.country) !== pool) continue;
    if (!out[r.staff_name] || r.end_date > out[r.staff_name]) out[r.staff_name] = r.end_date;
  }
  return out;
}

/** 一次性读出一批达人的触达、事件、未判冲突，按请求顺序返回规则输入 */
export async function loadInputs(pool: string, creators: CreatorRef[]): Promise<Input[]> {
  const keys = [...new Set(creators.map(creatorKey).filter(Boolean))];
  const names = [...new Set(creators.map((c) => normalizeHandle(c.username ?? "")).filter(Boolean))];
  // 安全：只保留不含过滤语法字符的值，防止 PostgREST or() 过滤注入
  const safe = (v: string) => /^[^"\\,()]{1,128}$/.test(v);
  keys.splice(0, keys.length, ...keys.filter(safe));
  names.splice(0, names.length, ...names.filter(safe));
  const orFilter = [keys.length ? `creator_key.in.(${keys.map((k) => `"${k}"`).join(",")})` : "", names.length ? `username.in.(${names.map((k) => `"${k}"`).join(",")})` : ""].filter(Boolean).join(",");
  if (!orFilter) return creators.map(() => ({ touches: [], events: [] }));
  const db = admin();
  const [t, e, c, leave] = await Promise.all([
    db.from("outreach_touches").select("creator_key,creator_open_id,username,bd,channel,shop_id,touched_at,touch_date,result").eq("site_pool", pool).eq("result", "sent").or(orFilter),
    db.from("outreach_creator_events").select("creator_key,creator_open_id,username,event,event_at,event_date,bd,shop_id").eq("site_pool", pool).or(orFilter),
    db.from("outreach_conflicts").select("creator_key,username,bds").eq("site_pool", pool).eq("status", "open").or(orFilter),
    loadLastWorkdays(pool),
  ]);
  for (const r of [t, e, c]) if (r.error) throw r.error;
  const match = (c: CreatorRef, row: { creator_key: string; creator_open_id?: string | null; username?: string | null }) =>
    row.creator_key === creatorKey(c) || (c.open_id && row.creator_open_id === c.open_id) ||
    (c.username && row.username && normalizeHandle(row.username) === normalizeHandle(c.username));
  return creators.map((cr) => ({
    touches: (t.data ?? []).filter((r) => match(cr, r)).map((r): Touch => ({
      date: r.touch_date, at: r.touched_at, bd: r.bd, channel: r.channel, shopId: r.shop_id ?? undefined,
    })),
    events: (e.data ?? []).filter((r) => match(cr, r)).map((r): OwnershipEvent => ({
      date: r.event_date, at: r.event_at, type: r.event, bd: r.bd ?? undefined, shopId: r.shop_id ?? undefined,
    })),
    openConflictBds: [...new Set((c.data ?? []).filter((r) => match(cr, r)).flatMap((r) => r.bds as string[]))],
    lastWorkday: leave,
  }));
}

/** 店铺 → 站点池（tts_shops.region；PH2/PHL 店铺在 tts_shops 里的 region 也按 PH 池） */
export async function poolOfShop(shopId: string): Promise<string> {
  const { data, error } = await admin().from("tts_shops").select("region").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  if (!data?.region) throw new Error(`tts_shops 里没有 shop_id=${shopId}`);
  return sitePool(data.region);
}
