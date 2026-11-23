// 校验 pg_cron 调用方：必须带 x-cron-key 且等于 vault 中的 gmv_max_cron_secret。
// 公开的 publishable key 不能作为调用方凭证（浏览器可见）。
import { createClient } from "@supabase/supabase-js";

export async function isCronCaller(request: Request): Promise<boolean> {
  const supplied = request.headers.get("x-cron-key") ?? "";
  if (!supplied) return false;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return false;
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc("get_gmv_cron_secret");
  if (error || typeof data !== "string" || !data) return false;
  if (data.length !== supplied.length) return false;
  let diff = 0;
  for (let i = 0; i < data.length; i++) diff |= data.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}
