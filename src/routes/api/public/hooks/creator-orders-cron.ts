// 达人出单日报 每小时刷新（pg_cron `creator-orders-hourly`，每小时第 23 分，带 x-cron-key）。
// 拉各广告户今天及前两天的 GMV Max 素材 × 商品数据（广告户时区），再给新 VID 补达人名。逻辑见 src/lib/creator-orders.server.ts。
import { createFileRoute } from "@tanstack/react-router";
import { isCronCaller } from "@/lib/cron-caller.server";
import { adminDb, enrichNames, syncAll } from "@/lib/creator-orders.server";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const Route = createFileRoute("/api/public/hooks/creator-orders-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isCronCaller(request))) return jsonRes({ error: "unauthorized" }, 401);
        const started = Date.now();
        const db = adminDb();
        try {
          const sync = await syncAll(db, { deadline: started + 6 * 60_000 });
          const names = await enrichNames(db, started + 8 * 60_000);
          return jsonRes({ ok: true, ms: Date.now() - started, sync, names });
        } catch (e) {
          return jsonRes({ ok: false, error: (e as Error).message }, 500);
        }
      },
    },
  },
});
