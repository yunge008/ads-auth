// SEA 库存监控：定时生成调整计划 + 推送飞书群。
//
// 两种调用：
//   ① pg_cron（北京 09:10 白天档 / 21:10 夜间档）：`apikey: <SUPABASE_PUBLISHABLE_KEY>` 头 → 下游带 x-cron-key；
//      拉海外仓库存（千易/顶妙 API；BigSeller 仓由人工在页面上传）→ 逐店同步 listing + 近 N 天订单（分片续跑）→ 夜间档刷新映射表 → 生成计划 → 发飞书。
//      没有任何仓库绑定店铺时直接跳过、不发消息（功能尚未配置）。
//   ② 页面「发送到飞书」：带 x-admin-passcode / x-admin-name，body `{manual:true, plan_id?}`，只按该计划组装并发送。
//
// 发送渠道：SEA_INV_FEISHU_WEBHOOK（库存群），没配则用 FEISHU_BOT_WEBHOOK（与每日授权通知同一个群）。
// 只发提醒、不改库存：改库存必须用户在网页确认后执行。
import { isCronCaller } from "@/lib/cron-caller.server";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const HARD_BUDGET_MS = 8 * 60 * 1000;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const bj = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

async function postFeishu(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.SEA_INV_FEISHU_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK;
  if (!url) throw new Error("服务端未配置 SEA_INV_FEISHU_WEBHOOK / FEISHU_BOT_WEBHOOK");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = (await r.json().catch(() => ({}))) as { code?: number; StatusCode?: number; msg?: string };
  const code = j.code ?? j.StatusCode ?? (r.ok ? 0 : r.status);
  if (code !== 0) throw new Error(`飞书机器人发送失败 code=${code}: ${j.msg ?? ""}`);
}

/** 先发带表格的卡片；表格组件被拒时退回纯文本，保证消息一定送达 */
async function sendPlan(msg: Record<string, unknown>) {
  try {
    await postFeishu({ msg_type: "interactive", card: msg.card });
    return "card";
  } catch (e) {
    console.error("[sea-inventory-cron] 卡片发送失败，改发纯文本", (e as Error).message);
    const lines = (msg.lines as string[]) ?? [];
    await postFeishu({
      msg_type: "post",
      content: { post: { zh_cn: { title: String(msg.title ?? "SEA 库存调整计划"), content: lines.slice(1).map((t) => [{ tag: "text", text: t }]) } } },
    });
    return "text";
  }
}

export const Route = createFileRoute("/api/public/hooks/sea-inventory-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const body = (await request.json().catch(() => ({}))) as { manual?: boolean; plan_id?: string; slot?: string };
        const passcode = request.headers.get("x-admin-passcode") ?? "";
        const manual = !!body.manual && !!passcode;

        let authHeaders: Record<string, string>;
        if (manual) {
          authHeaders = { "x-admin-passcode": passcode, "x-admin-name": request.headers.get("x-admin-name") ?? "" };
        } else {
          const callerKey = request.headers.get("apikey") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
          if (!(await isCronCaller(request))) return jsonRes({ error: "unauthorized" }, 401);
          const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
          const { data: cronKey, error } = await admin.rpc("get_gmv_cron_secret");
          if (error || !cronKey) return jsonRes({ error: "missing vault secret gmv_max_cron_secret", detail: error?.message }, 500);
          authHeaders = { "x-cron-key": cronKey as string };
        }

        const callFn = async (payload: Record<string, unknown>) => {
          const r = await fetch(`${supabaseUrl}/functions/v1/sea-inventory`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}`, ...authHeaders },
            body: JSON.stringify(payload),
          });
          const text = await r.text();
          let j: Record<string, unknown> = {};
          try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 400) }; }
          if (!r.ok) throw new Error(String(j.error ?? `HTTP ${r.status}`));
          return j;
        };

        if (manual) {
          try {
            const msg = await callFn({ action: "build_message", plan_id: body.plan_id });
            const via = await sendPlan(msg);
            return jsonRes({ ok: true, manual: true, via });
          } catch (e) {
            return jsonRes({ ok: false, error: (e as Error).message }, 500);
          }
        }

        const night = body.slot === "night";
        const started = Date.now();
        const steps: string[] = [];
        const errors: string[] = [];
        try {
          const ov = await callFn({ action: "overview" });
          const shops = (ov.linked_shops as string[]) ?? [];
          if (!shops.length) {
            console.log("[sea-inventory-cron] 尚未给任何仓库绑定店铺，跳过");
            return jsonRes({ ok: true, skipped: "no linked shops" });
          }
          // 1. 海外仓库存（有 API 的仓；失败只记录，生成计划时该仓按「库存过期」跳过并在卡片置顶说明）
          for (const w of (ov.warehouses as Array<{ code: string; provider: string; status: string; kind: string }>) ?? []) {
            if (w.status === "disabled" || w.kind !== "overseas" || !["qianyi", "dingmiao"].includes(w.provider)) continue;
            try {
              const r = await callFn({ action: "sync_warehouse", code: w.code });
              steps.push(`${w.code}:${r.ok ? "ok" : "fail"}`);
            } catch (e) {
              errors.push(`${w.code} 库存同步异常：${(e as Error).message}`);
            }
          }
          // 2. 店铺 listing + 订单（分片续跑）
          for (const shopId of shops) {
            let cursor: unknown = null;
            let rounds = 0;
            try {
              do {
                const r = await callFn({ action: "sync_shop", shop_id: shopId, cursor });
                cursor = r.done ? null : r.cursor;
                rounds++;
              } while (cursor && rounds < 30 && Date.now() - started < HARD_BUDGET_MS);
              if (cursor) errors.push(`店铺 ${shopId} 同步超时未完成（${rounds} 轮）`);
              steps.push(`shop ${shopId}:${rounds}`);
            } catch (e) {
              errors.push(`店铺 ${shopId} 同步失败：${(e as Error).message}`);
            }
          }
          // 3. 夜间档刷新映射表
          let mapDiff: unknown = null;
          if (night) {
            try {
              mapDiff = await callFn({ action: "refresh_map" });
            } catch (e) {
              errors.push(`映射表刷新失败：${(e as Error).message}`);
            }
          }
          // 4. 生成计划 + 发飞书
          const plan = await callFn({ action: "build_plan", map_diff: mapDiff });
          const msg = await callFn({ action: "build_message", plan_id: plan.plan_id });
          if (errors.length) {
            const card = msg.card as { elements?: unknown[] };
            card.elements = [{ tag: "markdown", content: errors.map((e) => `<font color='red'>⚠ ${e.slice(0, 200)}</font>`).join("\n") }, ...(card.elements ?? [])];
            msg.lines = [...((msg.lines as string[]) ?? []).slice(0, 1), ...errors, ...((msg.lines as string[]) ?? []).slice(1)];
          }
          const via = await sendPlan(msg);
          const out = { ok: true, night, plan_id: plan.plan_id, summary: plan.summary, steps, errors, via, elapsed_ms: Date.now() - started };
          console.log("[sea-inventory-cron]", JSON.stringify(out));
          return jsonRes(out);
        } catch (e) {
          const err = (e as Error).message;
          console.error("[sea-inventory-cron]", err);
          try {
            await postFeishu({
              msg_type: "interactive",
              card: {
                config: { wide_screen_mode: true },
                header: { template: "red", title: { tag: "plain_text", content: "⚠ SEA 库存监控任务失败，本次没有生成调整计划" } },
                elements: [{ tag: "markdown", content: [`**错误**：${err.slice(0, 400)}`, ...errors.map((x) => `- ${x.slice(0, 200)}`), `**时间**：${bj()}`, "请到网页「SEA库存监控」手动点「生成计划」重试。"].join("\n") }],
              },
            });
          } catch (n) {
            console.error("[sea-inventory-cron] 失败通知也发送失败", (n as Error).message);
          }
          return jsonRes({ ok: false, error: err, steps, errors }, 500);
        }
      },
    },
  },
});
