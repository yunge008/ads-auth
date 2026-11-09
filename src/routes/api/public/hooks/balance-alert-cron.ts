// 账户余额预警：刷新 + 发飞书。
//
// 发送渠道 = FEISHU_BOT_WEBHOOK（与每日自动授权通知同一个群），这个 webhook 只配在服务端环境变量里，
// 所以消息由 Edge Function `balance-alert` 的 build_message 组装、本路由负责 POST 到 webhook。
//
// 两种调用：
//   ① pg_cron（每天北京 10:00）：`apikey: <SUPABASE_PUBLISHABLE_KEY>` 头 → 下游带 x-cron-key；
//      先 refresh（分片续跑到 remaining 为空）再 build_message，有预警/有算不出的户才发。
//   ② 页面「发送到飞书」按钮：带 x-admin-passcode / x-admin-name，原样转给 Edge Function 校验（需 settings 权限）；
//      body `{ manual: true }`，不刷新，只按库里当前快照组装并强制发送（无预警也发一条，用于确认通道）。
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const HARD_BUDGET_MS = 8 * 60 * 1000;
const MAX_ROUNDS = 20;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function postFeishuBot(title: string, lines: string[]): Promise<void> {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) throw new Error("服务端未配置 FEISHU_BOT_WEBHOOK");
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "post",
      content: {
        post: { zh_cn: { title, content: lines.map((t) => [{ tag: "text", text: t }]) } },
      },
    }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    code?: number;
    StatusCode?: number;
    msg?: string;
  };
  const code = j.code ?? j.StatusCode ?? (r.ok ? 0 : r.status);
  if (code !== 0) throw new Error(`飞书机器人发送失败 code=${code}: ${j.msg ?? ""}`);
}

export const Route = createFileRoute("/api/public/hooks/balance-alert-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const body = (await request.json().catch(() => ({}))) as { manual?: boolean };
        const passcode = request.headers.get("x-admin-passcode") ?? "";
        const manual = !!body.manual && !!passcode;

        let authHeaders: Record<string, string>;
        if (manual) {
          authHeaders = {
            "x-admin-passcode": passcode,
            "x-admin-name": request.headers.get("x-admin-name") ?? "",
          };
        } else {
          const callerKey =
            request.headers.get("apikey") ??
            request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
            "";
          if (!anonKey || callerKey !== anonKey) return jsonRes({ error: "unauthorized" }, 401);
          const admin = createClient(supabaseUrl, serviceKey, {
            auth: { autoRefreshToken: false, persistSession: false },
          });
          const { data: cronKey, error: secretErr } = await admin.rpc("get_gmv_cron_secret");
          if (secretErr || !cronKey) {
            return jsonRes(
              { error: "missing vault secret gmv_max_cron_secret", detail: secretErr?.message },
              500,
            );
          }
          authHeaders = { "x-cron-key": cronKey as string };
        }

        const callFn = async (payload: Record<string, unknown>) => {
          const r = await fetch(`${supabaseUrl}/functions/v1/balance-alert`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
              ...authHeaders,
            },
            body: JSON.stringify(payload),
          });
          const text = await r.text();
          if (!r.ok) {
            let msg = text.slice(0, 400);
            try {
              msg = (JSON.parse(text) as { error?: string }).error ?? msg;
            } catch {
              /* keep raw */
            }
            throw new Error(msg);
          }
          return JSON.parse(text) as Record<string, unknown>;
        };

        const started = Date.now();
        let rounds = 0;
        let checked = 0;
        let remaining: string[] = [];
        try {
          if (!manual) {
            let first = true;
            do {
              const r = await callFn({
                action: "refresh",
                ...(first ? {} : { advertiser_ids: remaining }),
              });
              first = false;
              checked += Number(r.done ?? 0);
              remaining = (r.remaining as string[] | undefined) ?? [];
              rounds++;
            } while (
              remaining.length &&
              rounds < MAX_ROUNDS &&
              Date.now() - started < HARD_BUDGET_MS
            );
          }
          const msg = await callFn({ action: "build_message", force: manual });
          let sent = false;
          if (msg.send) {
            await postFeishuBot(String(msg.title), (msg.lines as string[]) ?? []);
            sent = true;
            const ids = (msg.alert_ids as string[]) ?? [];
            if (ids.length) await callFn({ action: "mark_alerted", advertiser_ids: ids });
          }
          const out = {
            ok: true,
            manual,
            rounds,
            checked,
            remaining: remaining.length,
            sent,
            alerts: msg.alerts ?? 0,
            broken: msg.broken ?? 0,
            elapsed_ms: Date.now() - started,
          };
          console.log("[balance-alert-cron]", JSON.stringify(out));
          return jsonRes(out);
        } catch (e) {
          console.error("[balance-alert-cron]", (e as Error).message);
          return jsonRes({ ok: false, error: (e as Error).message, rounds, checked }, 500);
        }
      },
    },
  },
});
