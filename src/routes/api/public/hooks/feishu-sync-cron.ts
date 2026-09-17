// Cron entrypoint：每晚把「读飞书 → 写自己库」的四个基础同步各跑一次。
// 等价于人工在页面上依次点：
//   ① 发样及素材统计 →「同步飞书数据」     （feishu-read-connection-stats）
//   ② GMV 归因·管理 →「同步达人登记」      （attribution-sync-creators）
//   ③ GMV 归因·管理 →「同步 GMV 目标」     （attribution-feishu / sync-targets）
//   ④ GMV 归因·管理 →「同步站点交接」      （attribution-feishu / sync-handovers）
//
// 排在北京 23:00，比归因快照（attribution-cron，北京 23:30）早半小时：
// 快照是拿「当下的登记数据」现算的，所以必须先把登记/目标/交接同步完，快照才用得上当天的新数据。
//
// 四步互相独立、按顺序串行执行：其中一步失败不影响后面几步，最后一起汇总；
// 有失败时发一条飞书机器人通知（FEISHU_BOT_WEBHOOK 未配置则只打日志）。
//
// Auth: 需要 `apikey: <SUPABASE_PUBLISHABLE_KEY>` 头（pg_cron 传入）。
// 调下游 Edge Function 时带 `x-cron-key`（vault secret），由 verify_gmv_cron_key RPC 校验以跳过管理口令。
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/** 单步硬超时：正常几十秒，卡住就放弃这一步继续下一步，别把整晚的任务拖死。 */
const STEP_TIMEOUT_MS = 4 * 60 * 1000;

type StepResult = {
  step: string;
  ok: boolean;
  summary?: string;
  error?: string;
  elapsed_ms: number;
};

async function postFeishuBot(title: string, lines: string[]): Promise<void> {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) {
    console.warn("[feishu-sync-cron] FEISHU_BOT_WEBHOOK not set, skip notification");
    return;
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "post",
        content: { post: { zh_cn: { title, content: lines.map((t) => [{ tag: "text", text: t }]) } } },
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn(`[feishu-sync-cron] feishu bot HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[feishu-sync-cron] feishu bot fetch failed: ${(e as Error).message}`);
  }
}

export const Route = createFileRoute("/api/public/hooks/feishu-sync-cron")({
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

        // 允许手动只跑其中几步（排查时用），默认四步全跑。
        let only: string[] | undefined;
        try {
          const body = (await request.json()) as { only?: string[] };
          if (Array.isArray(body?.only) && body.only.length) only = body.only;
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

        const callFn = async (fn: string, payload: Record<string, unknown>) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
          try {
            const r = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-cron-key": cronKey as string,
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
              },
              body: JSON.stringify(payload),
              signal: ctrl.signal,
            });
            const text = await r.text();
            if (!r.ok) throw new Error(`${fn} ${r.status}: ${text.slice(0, 400)}`);
            return JSON.parse(text) as Record<string, unknown>;
          } finally {
            clearTimeout(timer);
          }
        };

        const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
        const steps: Array<{
          key: string;
          label: string;
          run: () => Promise<string>;
        }> = [
          {
            key: "connection-stats",
            label: "发样及素材统计",
            run: async () => {
              const r = await callFn("feishu-read-connection-stats", {});
              const missing = Array.isArray(r.missing_sheets) ? (r.missing_sheets as string[]) : [];
              return `写入 ${num(r.inserted)} 行 / ${num(r.sheets_synced)} 张表` +
                (missing.length ? `（缺失 sheet：${missing.join("、")}）` : "");
            },
          },
          {
            key: "creators",
            label: "同步达人登记",
            run: async () => {
              // 分片跑：Edge Function 有 150 秒墙钟上限，登记数据涨到六万行后一次做不完，
              // 函数会返回 done:false + next，这里带着 next 继续调直到 done。
              let r = await callFn("attribution-sync-creators", {});
              let rounds = 1;
              const unfinished = (x: Record<string, unknown>) => x.done === false;
              while (unfinished(r) && rounds < 40) {
                const next = (r.next as Record<string, unknown> | undefined) ?? { resolve_only: true };
                r = await callFn("attribution-sync-creators", next);
                rounds++;
              }
              if (unfinished(r)) throw new Error(`分片轮数超过上限（${rounds} 轮）仍未完成`);
              const missing = Array.isArray(r.missing_sheets) ? (r.missing_sheets as string[]) : [];
              let s = `登记 ${num(r.registry_rows)} 行（含 VID ${num(r.registry_vid_rows)} 行）· 归属 ${num(r.ownership_keys)} 键 · 待审查 ${num(r.reviews_open)} · 分 ${rounds} 批`;
              if (missing.length) s += `（缺失 sheet：${missing.join("、")}）`;
              // 这两项会让归因静默失准，必须冒到通知里，不能只留在返回体里没人看。
              if (num(r.vid_precision_lost)) {
                s += `⚠ ${num(r.vid_precision_lost)} 个 VID 被飞书当数字返回、精度丢失已丢弃，请把对应列改成「文本」格式`;
              }
              if (!num(r.registry_vid_rows)) s += "⚠ 本次没读到任何有效 VID，VID 强匹配会完全失效";
              return s;
            },
          },
          {
            key: "targets",
            label: "同步 GMV 目标",
            run: async () => {
              const r = await callFn("attribution-feishu", { action: "sync-targets" });
              const skipped = Array.isArray(r.skipped) ? (r.skipped as string[]) : [];
              return `${num(r.upserted)} 条` + (skipped.length ? `（跳过 ${skipped.length} 条）` : "");
            },
          },
          {
            key: "handovers",
            label: "同步站点交接",
            run: async () => {
              const r = await callFn("attribution-feishu", { action: "sync-handovers" });
              const skipped = Array.isArray(r.skipped) ? (r.skipped as string[]) : [];
              return `${num(r.synced)} 条` + (skipped.length ? `（跳过 ${skipped.length} 条）` : "");
            },
          },
        ];

        const startedAt = Date.now();
        const results: StepResult[] = [];
        for (const step of steps) {
          if (only && !only.includes(step.key)) continue;
          const t0 = Date.now();
          try {
            const summary = await step.run();
            results.push({ step: step.key, ok: true, summary, elapsed_ms: Date.now() - t0 });
            console.log(`[feishu-sync-cron] ${step.key} ok: ${summary}`);
          } catch (e) {
            const msg = (e as Error).name === "AbortError"
              ? `超时（>${Math.round(STEP_TIMEOUT_MS / 1000)}s）`
              : (e as Error).message;
            results.push({ step: step.key, ok: false, error: msg, elapsed_ms: Date.now() - t0 });
            console.error(`[feishu-sync-cron] ${step.key} failed: ${msg}`);
          }
        }

        const failed = results.filter((r) => !r.ok);
        const labelOf = (key: string) => steps.find((s) => s.key === key)?.label ?? key;

        // 记一行运行状态，方便事后查「昨晚到底同步没同步」。
        await admin.from("gmv_max_sync_state").upsert({
          id: "feishu_nightly_sync",
          last_synced_at: new Date().toISOString(),
          note: results
            .map((r) => `${labelOf(r.step)}：${r.ok ? r.summary : `失败 ${r.error}`}`)
            .join(" | ")
            .slice(0, 2000),
        });

        if (failed.length) {
          await postFeishuBot(
            "飞书基础数据自动同步异常",
            results.map((r) => `${r.ok ? "✅" : "❌"} ${labelOf(r.step)}：${r.ok ? r.summary : r.error}`),
          );
        }

        console.log(
          `[feishu-sync-cron] ${results.length} step(s) in ${Date.now() - startedAt}ms` +
            (failed.length ? `, ${failed.length} failed` : ""),
        );
        return new Response(
          JSON.stringify({ ok: failed.length === 0, elapsed_ms: Date.now() - startedAt, results }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
