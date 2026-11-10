// ECO 后台连通性探测（只读，不登录、不带任何凭据）。
// 背景：2026-11-10 起 Supabase Edge Function 访问 business.ecoglobal.vip 全部超时（无令牌请求也超时），
// 判断为 ECO 拦截了 Supabase 出口 IP。本路由跑在 Lovable 服务端（Cloudflare），用来确认这边的出口能否到达 ECO；
// 能通的话再把 ECO 取数搬到服务端路由。浏览器直接打开即可：GET /api/public/hooks/eco-ping
import { createFileRoute } from "@tanstack/react-router";

const ECO_BASE = "https://business.ecoglobal.vip";

async function probe(label: string, path: string) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${ECO_BASE}${path}`, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      },
      signal: ctrl.signal,
    });
    await r.text().catch(() => "");
    return { label, ok: true, http_status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return {
      label,
      ok: false,
      ms: Date.now() - t0,
      error: err.name === "AbortError" ? "超时(15s)" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const Route = createFileRoute("/api/public/hooks/eco-ping")({
  server: {
    handlers: {
      GET: async () => {
        const probes = [
          await probe("账户列表(无令牌，预期 401)", "/api/adaccount/list?currentPage=1&pageSize=1"),
          await probe("登录接口(GET，预期 405)", "/api/auth/login"),
        ];
        return new Response(
          JSON.stringify({ runtime: "lovable-server(cloudflare)", probes }, null, 2),
          { headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      },
    },
  },
});
