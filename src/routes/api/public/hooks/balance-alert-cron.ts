// Cron entrypoint：每天北京 10:00 跑一次账户余额预警。
//   balance-alert refresh（分片续跑到 remaining 为空）→ balance-alert notify（有预警或有算不出的户才发飞书群）
// 飞书发送走已有飞书 app（FEISHU_APP_ID/SECRET）机器人发到「设置 → 账户余额预警」里选的群。
//
// Auth: 需要 `apikey: <SUPABASE_PUBLISHABLE_KEY>` 头（pg_cron 传入）；下游带 `x-cron-key`。
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const HARD_BUDGET_MS = 8 * 60 * 1000;
const MAX_ROUNDS = 20;

export const Route = createFileRoute("/api/public/hooks/balance-alert-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const callerKey =
          request.headers.get("apikey") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        if (!anonKey || callerKey !== anonKey) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const admin = createClient(supabaseUrl, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: cronKey, error: secretErr } = await admin.rpc("get_gmv_cron_secret");
        if (secretErr || !cronKey) {
          return new Response(
            JSON.stringify({
              error: "missing vault secret gmv_max_cron_secret",
              detail: secretErr?.message,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        const callFn = async (payload: Record<string, unknown>) => {
          const r = await fetch(`${supabaseUrl}/functions/v1/balance-alert`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-cron-key": cronKey as string,
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            body: JSON.stringify(payload),
          });
          const text = await r.text();
          if (!r.ok) throw new Error(`balance-alert ${r.status}: ${text.slice(0, 400)}`);
          return JSON.parse(text) as Record<string, unknown>;
        };

        const started = Date.now();
        let rounds = 0;
        let checked = 0;
        let remaining: string[] | undefined;
        try {
          do {
            const r = await callFn({
              action: "refresh",
              ...(remaining ? { advertiser_ids: remaining } : {}),
            });
            checked += Number(r.done ?? 0);
            remaining = (r.remaining as string[] | undefined) ?? [];
            rounds++;
          } while (
            remaining.length &&
            rounds < MAX_ROUNDS &&
            Date.now() - started < HARD_BUDGET_MS
          );
          const notify = await callFn({ action: "notify" });
          const out = {
            ok: true,
            rounds,
            checked,
            remaining: remaining?.length ?? 0,
            notify,
            elapsed_ms: Date.now() - started,
          };
          console.log("[balance-alert-cron]", JSON.stringify(out));
          return new Response(JSON.stringify(out), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("[balance-alert-cron]", (e as Error).message);
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error).message, rounds, checked }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      },
    },
  },
});
