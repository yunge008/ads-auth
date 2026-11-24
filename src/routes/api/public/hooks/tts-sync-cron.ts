// TikTok Shop 订单 / 财务结算 每日增量入库驱动（负责人 2026-11-25：先按天更新，先 PH、TH）。
//
// 调用方：
//   ① pg_cron `tts-daily-sync`（每小时第 17 分）：带 x-cron-key；
//   ② 管理员手动：带 x-admin-passcode / x-admin-name，body 可选 {shop_ids?: string[], parts?: ("orders"|"finance")[]}。
// 范围：tts_shops.daily_sync = true 的店铺（migration 20261125120000 先开 PH、TH）。
// 每店每部分循环调 Edge Function tts-export kind=sync 直到 finished 或本轮时间用完（下轮从 tts_sync_state.cursor 续跑）。
// 有报错，或接口出现口径表未登记且非 0 的字段 → 发飞书（FEISHU_BOT_WEBHOOK）；正常不发消息。
import { isCronCaller } from "@/lib/cron-caller.server";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const HARD_BUDGET_MS = 8 * 60 * 1000;
const PARTS = ["orders", "finance"] as const;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type SyncResult = { part: string; finished: boolean; done?: number; total?: number; tx?: number; errors?: string[]; new_unknown?: string[] };

async function postFeishu(title: string, lines: string[]) {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "post", content: { post: { zh_cn: { title, content: lines.map((t) => [{ tag: "text", text: t }]) } } } }),
  }).catch((e) => console.error("[tts-sync-cron] 飞书发送失败", (e as Error).message));
}

export const Route = createFileRoute("/api/public/hooks/tts-sync-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const db = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
        const body = (await request.json().catch(() => ({}))) as { shop_ids?: string[]; parts?: string[] };
        const passcode = request.headers.get("x-admin-passcode") ?? "";

        let authHeaders: Record<string, string>;
        if (passcode) {
          // 口令由 tts-export 自己校验（requireAdmin），这里只转发
          authHeaders = { "x-admin-passcode": passcode, "x-admin-name": request.headers.get("x-admin-name") ?? "" };
        } else {
          if (!(await isCronCaller(request))) return jsonRes({ error: "unauthorized" }, 401);
          const { data: cronKey, error } = await db.rpc("get_gmv_cron_secret");
          if (error || !cronKey) return jsonRes({ error: "missing vault secret gmv_max_cron_secret" }, 500);
          authHeaders = { "x-cron-key": cronKey as string };
        }

        let q = db.from("tts_shops").select("shop_id,shop_name,region").eq("daily_sync", true).eq("status", "ACTIVE");
        if (body.shop_ids?.length) q = q.in("shop_id", body.shop_ids);
        const { data: shops, error: shopErr } = await q;
        if (shopErr) return jsonRes({ error: shopErr.message }, 500);
        const parts = PARTS.filter((p) => !body.parts?.length || body.parts.includes(p));

        const started = Date.now();
        const report: Array<{ shop: string; part: string; finished: boolean; rounds: number; summary: string }> = [];
        const problems: string[] = [];
        for (const s of (shops ?? []) as Array<{ shop_id: string; shop_name: string | null; region: string | null }>) {
          const label = `${s.region ?? ""} ${s.shop_name ?? s.shop_id}`;
          for (const part of parts) {
            let rounds = 0;
            let last: SyncResult | null = null;
            while (Date.now() - started < HARD_BUDGET_MS) {
              rounds++;
              try {
                const r = await fetch(`${supabaseUrl}/functions/v1/tts-export`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}`, ...authHeaders },
                  body: JSON.stringify({ kind: "sync", part, shop_id: s.shop_id }),
                });
                const text = await r.text();
                let j: SyncResult & { error?: string };
                try { j = JSON.parse(text); } catch { j = { part, finished: false, error: text.slice(0, 300) }; }
                if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
                last = j;
                for (const e of j.errors ?? []) problems.push(`${label} ${part}：${e}`);
                for (const u of j.new_unknown ?? []) problems.push(`${label} ${part} 接口出现未登记的非 0 字段：${u}`);
                if (j.finished || (j.errors?.length ?? 0) > 0) break;
              } catch (e) {
                problems.push(`${label} ${part}：${(e as Error).message}`);
                break;
              }
            }
            report.push({
              shop: label, part, finished: !!last?.finished, rounds,
              summary: part === "orders" ? `订单 ${last?.done ?? 0}` : `结算单 ${last?.done ?? 0}/${last?.total ?? 0}、交易 ${last?.tx ?? 0}`,
            });
          }
        }
        if (problems.length) {
          await postFeishu("TikTok Shop 订单/财务入库：需处理", [
            ...problems.slice(0, 30),
            ...(problems.length > 30 ? [`……共 ${problems.length} 条`] : []),
          ]);
        }
        return jsonRes({ ok: problems.length === 0, report, problems });
      },
    },
  },
});
