// 「评论查看」每晚同步驱动（docs/LISTING_REVIEWS_PLAN.md）。
// pg_cron `reviews-nightly`（北京 00:35 / 01:35 / 02:35，避开 tts-daily-sync 的每小时第 17 分）带 x-cron-key 调本路由；
// 本路由循环调 Edge Function `reviews` action=step（每次 ≤ 约 100s），8 分钟内没跑完的由下一轮从游标续跑；
// 全部站点跑完后调 alert_scan：累计评价数达标且累计平均分新跌破门槛的 listing 合并发一条飞书（FEISHU_BOT_WEBHOOK）。
// 同步有报错也发飞书。
import { isCronCaller } from "@/lib/cron-caller.server";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const HARD_BUDGET_MS = 8 * 60 * 1000;
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function postFeishu(title: string, lines: string[]) {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "post", content: { post: { zh_cn: { title, content: lines.map((t) => [{ tag: "text", text: t }]) } } } }),
  }).catch((e) => console.error("[reviews-cron] 飞书发送失败", (e as Error).message));
}

type StepRes = { finished?: boolean; pending?: string[]; results?: { shop: string; done: boolean; idx: number; total: number; calls: number; error?: string }[]; error?: string };
type AlertItem = { site: string; pid: string; sku: string | null; avg: number; n: number; n30: number; bad30: number; new: boolean };

export const Route = createFileRoute("/api/public/hooks/reviews-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isCronCaller(request))) return jsonRes({ error: "unauthorized" }, 401);
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const db = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
        const { data: cronKey, error } = await db.rpc("get_gmv_cron_secret");
        if (error || !cronKey) return jsonRes({ error: "missing vault secret gmv_max_cron_secret" }, 500);
        const call = async (body: Record<string, unknown>) => {
          const r = await fetch(`${supabaseUrl}/functions/v1/reviews`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}`, "x-cron-key": cronKey as string },
            body: JSON.stringify(body),
          });
          const text = await r.text();
          try { return JSON.parse(text); } catch { return { error: `HTTP ${r.status} ${text.slice(0, 300)}` }; }
        };

        const started = Date.now();
        const problems: string[] = [];
        let last: StepRes = {};
        let rounds = 0;
        while (Date.now() - started < HARD_BUDGET_MS) {
          rounds++;
          last = (await call({ action: "step" })) as StepRes;
          if (last.error) { problems.push(`同步：${last.error}`); break; }
          for (const x of last.results ?? []) if (x.error) problems.push(`${x.shop}：${x.error}`);
          if (last.finished) break;
          if ((last.results ?? []).every((x) => x.error)) break; // 剩下的站点都报错，不空转
        }
        let alerts: AlertItem[] = [];
        if (last.finished) {
          const a = (await call({ action: "alert_scan" })) as { items?: AlertItem[]; threshold?: number; min_reviews?: number; error?: string };
          if (a.error) problems.push(`差评提示：${a.error}`);
          alerts = (a.items ?? []).filter((x) => x.new);
          if (alerts.length) {
            await postFeishu(`评分低于 ${Number(a.threshold).toFixed(1)} 的链接（累计 ≥ ${a.min_reviews} 条）`, alerts.map((x) =>
              `${x.site} · ${x.sku ?? "-"} · ${x.pid} · 当前 ${Number(x.avg).toFixed(2)} · 近30天评论 ${x.n30} · 差评 ${x.bad30}`));
          }
        }
        if (problems.length) await postFeishu("评论查看：每晚同步需处理", problems.slice(0, 30));
        return jsonRes({ ok: problems.length === 0, rounds, finished: !!last.finished, pending: last.pending ?? [], alerts: alerts.length, problems });
      },
    },
  },
});
