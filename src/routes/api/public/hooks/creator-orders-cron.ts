// 达人出单日报 定时同步（pg_cron `creator-orders-step`，每 5 分钟，带 x-cron-key）。
// 分步：每次 ≤25 秒，游标存 co_settings（sync_cursor / names_cursor / cycle_started_at）。
// 每个整点开始新一轮：先逐户拉今天及前两天 GMV Max 素材 × 商品（广告户时区），再给新 VID 补达人名。逻辑见 src/lib/creator-orders.server.ts。
import { createFileRoute } from "@tanstack/react-router";
import { isCronCaller } from "@/lib/cron-caller.server";
import { adminDb, enrichNames, syncAll } from "@/lib/creator-orders.server";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hourKey = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 13) : "";

export const Route = createFileRoute("/api/public/hooks/creator-orders-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isCronCaller(request))) return jsonRes({ error: "unauthorized" }, 401);
        const started = Date.now();
        const db = adminDb();
        try {
          const { data: st, error } = await db
            .from("co_settings")
            .select("sync_cursor,names_cursor,cycle_started_at")
            .eq("id", 1)
            .maybeSingle();
          if (error) throw new Error(error.message);
          let syncCursor = st?.sync_cursor as number | null;
          let namesCursor = st?.names_cursor as number | null;
          let cycle = st?.cycle_started_at as string | null;
          const now = new Date().toISOString();
          if (syncCursor == null && namesCursor == null && hourKey(cycle) !== hourKey(now)) {
            syncCursor = 0;
            cycle = now;
          }
          let step: unknown = "本小时已完成";
          const deadline = started + 25_000;
          if (syncCursor != null) {
            const r = await syncAll(db, { deadline, start: syncCursor });
            step = r;
            syncCursor = r.next;
            if (syncCursor == null) namesCursor = 0;
          } else if (namesCursor != null) {
            const r = await enrichNames(db, deadline, namesCursor);
            step = r;
            namesCursor = r.next;
          }
          await db
            .from("co_settings")
            .update({ sync_cursor: syncCursor, names_cursor: namesCursor, cycle_started_at: cycle })
            .eq("id", 1);
          return jsonRes({
            ok: true,
            ms: Date.now() - started,
            sync_cursor: syncCursor,
            names_cursor: namesCursor,
            step,
          });
        } catch (e) {
          return jsonRes({ ok: false, error: (e as Error).message }, 500);
        }
      },
    },
  },
});
