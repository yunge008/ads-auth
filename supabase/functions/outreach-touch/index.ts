// 触达记录回传（规则 §6.2）：插件群发 / 系统群发 / 定向 / 人工跟进，每条消息一行写入 outreach_touches，
// 参与 §2 冷却与 §3 认领。BD = 当前登录账号（插件沿用本系统账号与权限）。
// Body: { phase: "start" | "item" | "end", batch_id, shop_id, source?: "plugin"|"system",
//         items?: [{ username, nickname?, open_id?, content?, sent_at?, result?: "sent"|"failed"|"blocked", reason?,
//                    kind?, message_type?, conversation_id?, tc_id?, message_id?, client_ref? }],
//         summary?: { success, failed, reasons } }
// 同一条回传重复提交按 client_ref（缺省 = batch_id + 用户名 + 发送时间）去重。
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, verifyPasscode } from "../_shared/auth.ts";
import { normalizeHandle } from "../_shared/tts.ts";
import { bjDate } from "../_shared/ownership.ts";
import { creatorKey, poolOfShop } from "../_shared/outreach.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
type Item = {
  username?: string; nickname?: string; open_id?: string; content?: string; sent_at?: string | number; result?: string; reason?: string;
  kind?: string; message_type?: string; conversation_id?: string; tc_id?: string; message_id?: string; client_ref?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const acc = await verifyPasscode(req, "outreach");
    const b = (await req.json().catch(() => ({}))) as { phase?: string; batch_id?: string; shop_id?: string; source?: string; items?: Item[]; summary?: unknown };
    const phase = String(b.phase ?? "item");
    const batch = String(b.batch_id ?? "").trim();
    if (!batch) throw new Error("batch_id 必填");
    if (phase === "start" || phase === "end") return json({ ok: true, phase, batch_id: batch, bd: acc.name, summary: b.summary ?? null });
    const shopId = String(b.shop_id ?? "").trim();
    if (!shopId) throw new Error("shop_id 必填");
    const pool = await poolOfShop(shopId);
    const source = b.source === "system" ? "system" : "plugin";
    const items = (b.items ?? []).filter((x) => x && (x.username || x.open_id)).slice(0, 500);
    if (!items.length) throw new Error("items 不能为空（每次最多 500 条）");
    const rows = items.map((x) => {
      const at = x.sent_at ? new Date(typeof x.sent_at === "number" && x.sent_at < 1e12 ? x.sent_at * 1000 : x.sent_at) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error(`sent_at 无法解析：${x.sent_at}`);
      const result = ["sent", "failed", "blocked"].includes(String(x.result)) ? String(x.result) : "sent";
      return {
        site_pool: pool, shop_id: shopId, creator_key: creatorKey(x), creator_open_id: x.open_id ?? null,
        username: x.username ? normalizeHandle(x.username) : null, nickname: x.nickname ?? null, bd: acc.name,
        channel: "affiliate", kind: x.kind ?? (source === "plugin" ? "plugin_bulk" : "im_bulk"), source,
        touched_at: at.toISOString(), touch_date: bjDate(at), batch_id: batch, conversation_id: x.conversation_id ?? null,
        tc_id: x.tc_id ?? null, message_type: x.message_type ?? "TEXT", content: x.content ?? null, result, reason: x.reason ?? null,
        message_id: x.message_id ?? null,
        client_ref: x.client_ref ?? `${batch}|${normalizeHandle(x.username ?? x.open_id ?? "")}|${at.toISOString()}`,
      };
    });
    const { error, count } = await admin().from("outreach_touches").upsert(rows, { onConflict: "client_ref", ignoreDuplicates: true, count: "exact" });
    if (error) throw error;
    return json({ ok: true, site_pool: pool, bd: acc.name, received: rows.length, inserted: count ?? null });
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
