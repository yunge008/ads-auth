// 达人出单日报 页面接口。鉴权：x-admin-passcode，需「达人出单」页面权限或管理员。
// POST body:
//   {action:"query", start, end, countries?}   区间数据（素材 × 商品 聚合 + 逐日）+ 设置 + 各广告户同步状态
//   {action:"refresh_step", cursor}             立即刷新今天和昨天，分步（≤20 秒/步），返回 next 续跑
//   {action:"names_step", cursor}               给新 VID 补达人名，分步
//   {action:"settings", t_vid, t_cr, own_kw}    保存爆单门槛 / 官号关键词
import { createFileRoute } from "@tanstack/react-router";
import {
  adminDb,
  checkCoPasscode,
  enrichNames,
  queryRange,
  sgDate,
  syncAll,
} from "@/lib/creator-orders.server";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const Route = createFileRoute("/api/public/hooks/creator-orders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const db = adminDb();
        const authErr = await checkCoPasscode(db, request);
        if (authErr) return jsonRes({ error: authErr }, 401);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        try {
          switch (body.action) {
            case "query": {
              if (!isDate(body.start) || !isDate(body.end))
                return jsonRes({ error: "start / end 需为 YYYY-MM-DD" }, 400);
              const countries =
                Array.isArray(body.countries) && body.countries.length
                  ? (body.countries as unknown[]).map(String)
                  : null;
              return jsonRes(await queryRange(db, String(body.start), String(body.end), countries));
            }
            case "refresh_step": {
              // 分步：每步 ≤20 秒，页面按 next 续跑（Lovable 服务端单次请求时长有限）
              const r = await syncAll(db, {
                days: [sgDate(-1), sgDate(0)],
                deadline: Date.now() + 20_000,
                start: Number(body.cursor) || 0,
              });
              return jsonRes(r);
            }
            case "names_step": {
              const r = await enrichNames(db, Date.now() + 20_000, Number(body.cursor) || 0);
              return jsonRes(r);
            }
            case "settings": {
              const t_vid = Math.max(1, Math.round(Number(body.t_vid) || 10));
              const t_cr = Math.max(1, Math.round(Number(body.t_cr) || 20));
              const own_kw = String(body.own_kw ?? "artphro")
                .trim()
                .slice(0, 40);
              const { error } = await db
                .from("co_settings")
                .upsert({ id: 1, t_vid, t_cr, own_kw, updated_at: new Date().toISOString() });
              if (error) throw new Error(error.message);
              return jsonRes({ ok: true, t_vid, t_cr, own_kw });
            }
            default:
              return jsonRes({ error: "未知 action" }, 400);
          }
        } catch (e) {
          return jsonRes({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});
