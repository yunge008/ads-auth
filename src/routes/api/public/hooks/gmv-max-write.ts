// GMV Max 写操作服务端路由（免 Edge Function 部署积分）。逻辑见 src/lib/gmv-max-write.server.ts。
// POST body:
//   {action:"create", row:{...}}            单行建组（真实写，会产生花费）
//   {action:"auth_check", advertiser_id}    查店铺 GMV Max 独占授权持有户（只读）
//   {action:"auth_grant", advertiser_id}    切独占授权到该户（原持有户该店铺 GMV Max 组全部自动暂停）
//   {action:"spend", advertiser_id, days}    近 N 天 广告组×商品 消耗（只读）
//   {action:"products", advertiser_id, bc_id?} 店铺商品状态清单（只读）
// 鉴权：x-admin-passcode，需 gmv-max-create 页面权限。
import { createFileRoute } from "@tanstack/react-router";
import {
  adminDb, checkGmvMaxPasscode, createOne, exclusiveAuth, listStoreProducts, spendReport, type CreateRow,
} from "@/lib/gmv-max-write.server";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const Route = createFileRoute("/api/public/hooks/gmv-max-write")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authErr = await checkGmvMaxPasscode(request);
        if (authErr) return jsonRes({ error: authErr }, 401);
        const body = (await request.json().catch(() => ({}))) as {
          action?: string; row?: CreateRow; advertiser_id?: unknown; days?: unknown; bc_id?: unknown;
        };
        try {
          const db = adminDb();
          switch (body.action) {
            case "create":
              return jsonRes(await createOne(db, body.row ?? {}));
            case "auth_check":
              return jsonRes(await exclusiveAuth(db, String(body.advertiser_id ?? "").trim(), false));
            case "auth_grant":
              return jsonRes(await exclusiveAuth(db, String(body.advertiser_id ?? "").trim(), true));
            case "spend": // 只读：近 N 天 广告组×商品 消耗
              return jsonRes(await spendReport(db, String(body.advertiser_id ?? "").trim(), Number(body.days ?? 3) || 3));
            case "products": // 只读：店铺商品状态（是否可投、是否已在 GMV Max 组）
              return jsonRes(await listStoreProducts(db, String(body.advertiser_id ?? "").trim(), String(body.bc_id ?? "").trim() || undefined));
            default:
              return jsonRes({ error: "未知 action" }, 400);
          }
        } catch (e) {
          return jsonRes({ error: (e as Error).message }, 400);
        }
      },
    },
  },
});
