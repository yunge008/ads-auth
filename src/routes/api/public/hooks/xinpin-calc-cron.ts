// Cron entrypoint：新品推广 / 产品推广计划 统计回写（方案④，Edge Function `xinpin-tuiguang-calc` mode=write）。
//
// pg_cron 每小时 :25 调用（job `xinpin-calc-hourly`，migration 建好后默认停用，负责人确认后再启用）。
// 目标表 / 数据表只从 Edge Function 环境变量取（XINPIN_DATA_SPREADSHEET / XINPIN_TARGET_SPREADSHEET），
// cron 身份不接受请求体里的表链接，避免被改成写源表。
// 失败发飞书机器人（FEISHU_BOT_WEBHOOK），不静默。
import { isCronCaller } from "@/lib/cron-caller.server";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const TIMEOUT_MS = 140 * 1000;

async function postFeishuBot(title: string, lines: string[]): Promise<void> {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) {
    console.warn("[xinpin-calc-cron] FEISHU_BOT_WEBHOOK not set, skip notification");
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "post",
        content: { post: { zh_cn: { title, content: lines.map((t) => [{ tag: "text", text: t }]) } } },
      }),
    });
  } catch (e) {
    console.warn(`[xinpin-calc-cron] feishu bot failed: ${(e as Error).message}`);
  }
}

export const Route = createFileRoute("/api/public/hooks/xinpin-calc-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isCronCaller(request))) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: cronKey, error: secretErr } = await admin.rpc("get_gmv_cron_secret");
        if (secretErr || !cronKey) {
          return new Response(JSON.stringify({ error: "missing vault secret gmv_max_cron_secret" }), { status: 500 });
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        let ok = false;
        let summary = "";
        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/xinpin-tuiguang-calc`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-cron-key": cronKey as string,
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
            },
            body: JSON.stringify({ mode: "write" }),
            signal: ctrl.signal,
          });
          const text = await r.text();
          const j = JSON.parse(text) as { ok?: boolean; error?: string; elapsed_ms?: number; feishu_api_calls?: number };
          ok = r.ok && j.ok === true;
          summary = ok
            ? `耗时 ${Math.round((j.elapsed_ms ?? 0) / 1000)}s · 飞书 API ${j.feishu_api_calls ?? "?"} 次`
            : `HTTP ${r.status}：${j.error ?? text.slice(0, 300)}`;
        } catch (e) {
          summary = (e as Error).name === "AbortError" ? `超时（>${TIMEOUT_MS / 1000}s）` : (e as Error).message;
        } finally {
          clearTimeout(timer);
        }

        await admin.from("gmv_max_sync_state").upsert({
          id: "xinpin_calc_hourly",
          last_synced_at: new Date().toISOString(),
          note: `${ok ? "成功" : "失败"} ${summary}`.slice(0, 2000),
        });
        if (!ok) await postFeishuBot("新品推广统计回写失败", [summary, "下一小时会自动重跑；连续失败请查 Edge Function xinpin-tuiguang-calc"]);
        return new Response(JSON.stringify({ ok, summary }), {
          status: ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
