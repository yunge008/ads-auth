// GMV MAX 素材数据自动抓取（归因用）服务端路由。逻辑见 src/lib/gmv-max-material.server.ts，规则见 docs/AUTO_DATA_PLAN.md 第二节。
// POST body:
//   {action:"start", country, month}   建抓取批次（范围 = 设置里该站点全部广告户，含未启用）
//   {action:"step", batch_id}          跑一步（每步 ≤30 次 TikTok 调用），返回 done=true 为止
//   {action:"retry", batch_id}         失败的广告户放回队列
//   {action:"reconcile", batch_id}     与该站点该月已上传的表对账，报告写进批次
//   {action:"probe_posted", country}  一次性：探测按 VID 取发布时间的候选接口，原始返回存库
//   {action:"probe_batch", country, month}  一次性：该站点该月上传表全部有花费 VID 查 batch_performance（覆盖率/发布时间/username）
//   {action:"probe_creative", country}  一次性：GMV Max 报表按 3 种维度组合探测达人名/内容类型/标题字段，原始返回存库
//   {action:"list"} / {action:"get", batch_id}  只读
// 鉴权：x-admin-passcode，需「归因管理」页面权限（经 attribution-upload 校验）。
// 只写 gmv_max_material_* / gmv_max_adv_daily 三张独立表，不影响归因计算。
import { createFileRoute } from "@tanstack/react-router";
import {
  adminDb,
  checkAttributionPasscode,
  getBatch,
  listBatches,
  probeBatchPerformance,
  probeCreativeFields,
  probePostedTime,
  reconcileBatch,
  retryFailed,
  startBatch,
  stepBatch,
} from "@/lib/gmv-max-material.server";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const Route = createFileRoute("/api/public/hooks/gmv-max-material")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authErr = await checkAttributionPasscode(request);
        if (authErr) return jsonRes({ error: authErr }, 401);
        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          country?: unknown;
          month?: unknown;
          batch_id?: unknown;
        };
        const id = String(body.batch_id ?? "").trim();
        try {
          const db = adminDb();
          switch (body.action) {
            case "start": {
              const operator = decodeURIComponent(request.headers.get("x-admin-name") ?? "");
              return jsonRes(
                await startBatch(
                  db,
                  String(body.country ?? "")
                    .trim()
                    .toUpperCase(),
                  String(body.month ?? "").trim(),
                  operator,
                ),
              );
            }
            case "step":
              return jsonRes(await stepBatch(db, id));
            case "retry":
              return jsonRes(await retryFailed(db, id));
            case "reconcile":
              return jsonRes(await reconcileBatch(db, id));
            case "probe_posted":
              return jsonRes(
                await probePostedTime(
                  db,
                  String(body.country ?? "")
                    .trim()
                    .toUpperCase(),
                  request.headers.get("x-admin-passcode") ?? "",
                  request.headers.get("x-admin-name") ?? "",
                ),
              );
            case "probe_creative":
              return jsonRes(
                await probeCreativeFields(
                  db,
                  String(body.country ?? "")
                    .trim()
                    .toUpperCase(),
                ),
              );
            case "probe_batch":
              return jsonRes(
                await probeBatchPerformance(
                  db,
                  String(body.country ?? "")
                    .trim()
                    .toUpperCase(),
                  String(body.month ?? "").trim(),
                  request.headers.get("x-admin-passcode") ?? "",
                  request.headers.get("x-admin-name") ?? "",
                ),
              );
            case "list":
              return jsonRes({ batches: await listBatches(db) });
            case "get":
              return jsonRes(await getBatch(db, id));
            default:
              return jsonRes({ error: `未知 action: ${body.action}` }, 400);
          }
        } catch (e) {
          return jsonRes({ error: (e as Error).message }, 400);
        }
      },
    },
  },
});
