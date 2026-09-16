// pg_cron 免口令校验。
//
// 定时任务不可能持有管理口令，所以服务端路由（src/routes/api/public/hooks/*）调用
// Edge Function 时会带上 `x-cron-key: <vault secret gmv_max_cron_secret>`，
// 由本函数经 `verify_gmv_cron_key` RPC（SECURITY DEFINER，仅 service_role 可执行）校验。
//
// 说明：这里只回答「这个请求是不是来自我们自己的 cron」，**不代表放行任何动作**。
// 调用方必须自己决定 cron 身份允许做什么（例如 attribution-feishu 只放行两个纯同步 action），
// 没有 x-cron-key 或校验不过时一律回落到原本的口令校验。
import { admin } from "./auth.ts";

export async function cronAuthed(req: Request): Promise<boolean> {
  const key = req.headers.get("x-cron-key") ?? "";
  if (!key) return false;
  const { data } = await admin().rpc("verify_gmv_cron_key", { _key: key });
  return data === true;
}
