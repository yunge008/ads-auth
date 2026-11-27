// 达人出单日报 定时同步（pg_cron `creator-orders-step`，每 5 分钟，带 x-cron-key）。
// 分步：每次 ≤25 秒，游标存 co_settings（sync_cursor / names_cursor / cycle_started_at）。
// 每个整点开始新一轮：先逐户拉 GMV Max 素材 × 商品，再给新 VID 补达人名。逻辑见 src/lib/creator-orders.server.ts。
// 刷哪几天见 cycleDays（新加坡时间：今天每小时、昨天每 6 小时、前天 6/18 点）；只查当天启用的户（co_adv_active）。
import { createFileRoute } from "@tanstack/react-router";
import { isCronCaller } from "@/lib/cron-caller.server";
import { adminDb, cycleDays, enrichNames, syncAll } from "@/lib/creator-orders.server";

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
            .select("sync_cursor,names_cursor,cycle_started_at,sync_tries")
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
            // 先记一次尝试：若本次请求被中途掐断，下次同一步再失败就跳过（避免卡死在一个大户上）
            const tries = (st?.sync_tries as number | null) ?? 0;
            await db
              .from("co_settings")
              .update({ sync_cursor: syncCursor, cycle_started_at: cycle, sync_tries: tries + 1 })
              .eq("id", 1);
            const r = await syncAll(db, {
              days: cycleDays(cycle ?? now),
              deadline,
              start: syncCursor,
              skipAt: tries >= 2 ? syncCursor : undefined,
            });
            step = r;
            syncCursor = r.next;
            if (syncCursor == null) namesCursor = 0;
          } else if (namesCursor != null && new Date().getUTCMinutes() >= 45) {
            // 错峰（负责人 2026-11-27）：补名用 Shop Analytics，只在每小时 :45–:59 跑，避开 reviews（:35 起）等同店同类调用
            const r = await enrichNames(db, deadline, namesCursor);
            step = r;
            namesCursor = r.next;
          }
          await db
            .from("co_settings")
            .update({
              sync_cursor: syncCursor,
              names_cursor: namesCursor,
              cycle_started_at: cycle,
              sync_tries: 0,
            })
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
