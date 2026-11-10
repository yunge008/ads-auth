// ECO 代理商后台操作入口（服务端路由，Cloudflare 出口 —— Supabase 出口被 ECO 拦截，见 src/lib/eco.server.ts）。
//
// POST body {action}:
//   sync        同步 ECO 余额到 eco_balances（cron 或有 settings 权限的口令）
//   status      ECO 配置 / 信任设备 / 最近同步状态（settings 权限）
//   2fa_send    {method} 发二次验证码（仅管理员）
//   2fa_verify  {method, code} 提交验证码、记住设备（仅管理员）
// 鉴权：cron 带 apikey=<SUPABASE_PUBLISHABLE_KEY> 只放行 sync；页面请求带 x-admin-passcode/x-admin-name，
// 转给 Edge Function balance-alert 的 auth_check 校验（与其他页面同一套口令体系）。
import process from "node:process";
import { createFileRoute } from "@tanstack/react-router";
import { eco2faSend, eco2faVerify, ecoStatus, syncEcoBalances } from "@/lib/eco.server";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function checkPasscode(request: Request, admin: boolean): Promise<string | null> {
  const passcode = request.headers.get("x-admin-passcode") ?? "";
  if (!passcode) return "未登录";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/balance-alert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "x-admin-passcode": passcode,
      "x-admin-name": request.headers.get("x-admin-name") ?? "",
    },
    body: JSON.stringify({ action: "auth_check", admin }),
  });
  if (r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `鉴权失败 HTTP ${r.status}`;
}

export const Route = createFileRoute("/api/public/hooks/eco")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          method?: number;
          code?: string;
        };
        const action = String(body.action ?? "status");
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const isCron =
          !request.headers.get("x-admin-passcode") &&
          !!anonKey &&
          request.headers.get("apikey") === anonKey;
        if (!(isCron && action === "sync")) {
          const err = await checkPasscode(request, action.startsWith("2fa_"));
          if (err) return jsonRes({ error: err }, 401);
        }
        try {
          switch (action) {
            case "sync":
              return jsonRes(await syncEcoBalances());
            case "status":
              return jsonRes(await ecoStatus());
            case "2fa_send":
              return jsonRes(await eco2faSend(body.method ? Number(body.method) : undefined));
            case "2fa_verify": {
              const code = String(body.code ?? "").trim();
              if (!code) return jsonRes({ error: "请输入验证码" }, 400);
              return jsonRes(await eco2faVerify(Number(body.method ?? 1), code));
            }
            default:
              return jsonRes({ error: `未知 action: ${action}` }, 400);
          }
        } catch (e) {
          return jsonRes({ error: (e as Error).message }, 400);
        }
      },
    },
  },
});
