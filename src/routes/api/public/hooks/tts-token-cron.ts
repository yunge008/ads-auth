// TikTok Shop token 自动刷新（pg_cron `tts-token-refresh`，每天北京 05:17）。
//
// `apikey: <SUPABASE_PUBLISHABLE_KEY>` 头 → 下游 tts-p0-probe 带 x-cron-key，只放行 action=refresh_due：
// 刷新 access 将在 48 小时内到期的全部授权（多应用：各自用所属应用的 app_key/app_secret）。
// 有失败（含 refresh_token 过期需重新授权）才发飞书 FEISHU_BOT_WEBHOOK，全部成功不打扰。
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type RefreshResult = { app: string; shops: string[]; ok: boolean; message: string };

async function notify(text: string) {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) {
    console.error("[tts-token-cron] 未配置 FEISHU_BOT_WEBHOOK，无法通知：", text);
    return;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  }).catch((e) => console.error("[tts-token-cron] 飞书发送失败", e));
}

export const Route = createFileRoute("/api/public/hooks/tts-token-cron")({
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
        if (!anonKey || callerKey !== anonKey) return jsonRes({ error: "unauthorized" }, 401);

        const admin = createClient(supabaseUrl, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: cronKey, error } = await admin.rpc("get_gmv_cron_secret");
        if (error || !cronKey)
          return jsonRes(
            { error: "missing vault secret gmv_max_cron_secret", detail: error?.message },
            500,
          );

        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/tts-p0-probe`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
              "x-cron-key": cronKey as string,
            },
            body: JSON.stringify({ action: "refresh_due", within_hours: 48 }),
          });
          const text = await r.text();
          let j: { error?: string; failed?: number; groups?: number; results?: RefreshResult[] } =
            {};
          try {
            j = JSON.parse(text);
          } catch {
            j = { error: text.slice(0, 400) };
          }
          if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          const failed = (j.results ?? []).filter((x) => !x.ok);
          if (failed.length) {
            await notify(
              [
                `⚠️ TikTok Shop token 自动刷新：${failed.length}/${j.groups} 组失败`,
                ...failed.map((f) => `· [${f.app}] ${f.shops.join("、")}：${f.message}`),
                "处理：设置 → TikTok Shop 授权，对应应用重新授权",
              ].join("\n"),
            );
          }
          return jsonRes({ ok: true, groups: j.groups ?? 0, failed: failed.length });
        } catch (e) {
          await notify(`❌ TikTok Shop token 自动刷新任务失败：${(e as Error).message}`);
          return jsonRes({ ok: false, error: (e as Error).message }, 500);
        }
      },
    },
  },
});
