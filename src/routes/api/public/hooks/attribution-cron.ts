// Cron entrypoint：每晚刷新一次 GMV 归因结果快照（第二层存储）。
// 等价于在页面上对最近几个月各点一次「立即重算」：读第一层 ad_upload_agg + 当下的飞书登记数据，
// 跑一次全站点全人员归因，把结果写进 attribution_runs / attribution_run_rows，前台直接读最新快照。
//
// Auth: 需要 `apikey: <SUPABASE_PUBLISHABLE_KEY>` 头（pg_cron 传入）。
// 调下游 Edge Function 时带 `x-cron-key`（vault secret），由 verify_gmv_cron_key RPC 校验以跳过管理口令。
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/** 默认刷新最近 3 个「有已完成上传批次」的月份。 */
const DEFAULT_LOOKBACK_MONTHS = 3;

type PlanEntry = {
  month: string;
  run_id?: string;
  remaining?: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

type RefreshResult = {
  months?: string[];
  staged?: boolean;
  plans?: PlanEntry[];
  results?: Array<{ month: string; ok: boolean; error?: string }>;
  error?: string;
};

export const Route = createFileRoute("/api/public/hooks/attribution-cron")({
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

        let lookback = DEFAULT_LOOKBACK_MONTHS;
        let months: string[] | undefined;
        try {
          const body = (await request.json()) as { lookback_months?: number; months?: string[] };
          if (body?.lookback_months && Number.isFinite(body.lookback_months)) {
            lookback = Math.max(1, Math.min(24, Math.round(body.lookback_months)));
          }
          if (Array.isArray(body?.months) && body.months.length) months = body.months;
        } catch {
          /* 空 body 正常 */
        }

        const admin = createClient(supabaseUrl, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: cronKey, error: secretErr } = await admin.rpc("get_gmv_cron_secret");
        if (secretErr || !cronKey) {
          return new Response(
            JSON.stringify({ error: "missing vault secret gmv_max_cron_secret", detail: secretErr?.message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const startedAt = Date.now();

        // 重算由这里分步驱动：Edge Function 一次请求只做一件事（建分片 → 判一片 → 收尾），
        // 因为它有 CPU 配额，整月二十几万个判定键一口气判完必然被掐断。
        const call = async (body: Record<string, unknown>) => {
          const r = await fetch(`${supabaseUrl}/functions/v1/attribution-upload`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-cron-key": cronKey as string,
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            body: JSON.stringify(body),
          });
          const text = await r.text();
          if (!r.ok) throw new Error(`attribution-upload ${r.status}: ${text.slice(0, 400)}`);
          return JSON.parse(text) as Record<string, unknown>;
        };

        let payload: RefreshResult;
        const results: Array<{ month: string; ok: boolean; error?: string }> = [];
        try {
          payload = (await call({
            action: "refresh",
            source: "CRON",
            ...(months ? { months } : { lookback_months: lookback }),
          })) as RefreshResult;

          for (const plan of payload.plans ?? []) {
            if (plan.error) {
              results.push({ month: plan.month, ok: false, error: plan.error });
              continue;
            }
            if (plan.skipped || !plan.run_id) {
              results.push({ month: plan.month, ok: true });
              continue;
            }
            try {
              for (let i = 0; i < 500; i++) {
                const r = (await call({
                  action: "refresh",
                  source: "CRON",
                  stage: "judge",
                  run_id: plan.run_id,
                  months: [plan.month],
                })) as { done?: boolean; remaining?: number };
                if (r.done || Number(r.remaining ?? 0) === 0) break;
              }
              await call({
                action: "refresh",
                source: "CRON",
                stage: "finish",
                run_id: plan.run_id,
                months: [plan.month],
              });
              results.push({ month: plan.month, ok: true });
            } catch (e) {
              results.push({ month: plan.month, ok: false, error: (e as Error).message });
            }
          }
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        payload.results = results;

        const failed = results.filter((x) => !x.ok);
        console.log(
          `[attribution-cron] refreshed ${(payload.results ?? []).length} month(s) in ${Date.now() - startedAt}ms` +
            (failed.length ? `, ${failed.length} failed` : ""),
        );
        return new Response(
          JSON.stringify({
            ok: failed.length === 0,
            elapsed_ms: Date.now() - startedAt,
            months: payload.months ?? [],
            results: payload.results ?? [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
