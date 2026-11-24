// AI 只读查询通道（负责人 2026-11-24 同意）。数据库侧见 migration 20261124150000_ai_readonly.sql。
// 鉴权：请求头 x-ai-db-key = 「设置 → 账号管理」里名为「AI只读」、非管理员、启用中的账号口令（按 sha256 比对）。
//       删除或停用该账号即撤销。口令存在 Claude 云环境的代理密钥里，不进仓库、不进聊天。
// POST body:
//   {action:"query", sql, max_rows?}  只读 SELECT/WITH，ai_reader 角色 + 只读事务，最多 2000 行
//   {action:"refresh_grants"}         新增表后按同一规则补授列权限（敏感列名永不授予）
import { createFileRoute } from "@tanstack/react-router";
import { adminDb } from "@/lib/gmv-max-write.server";

const AI_ACCOUNT_NAME = "AI只读";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const Route = createFileRoute("/api/public/hooks/ai-db-read")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = (request.headers.get("x-ai-db-key") ?? "").trim();
        if (!key) return jsonRes({ error: "未授权" }, 401);
        const db = adminDb();
        const { data: acct, error: authErr } = await db
          .from("app_accounts")
          .select("id")
          .eq("passcode_hash", await sha256Hex(key))
          .eq("name", AI_ACCOUNT_NAME)
          .eq("is_admin", false)
          .eq("active", true)
          .maybeSingle();
        if (authErr || !acct) return jsonRes({ error: "未授权" }, 401);

        const body = (await request.json().catch(() => ({}))) as { action?: string; sql?: unknown; max_rows?: unknown };
        if (body.action === "query") {
          const sql = String(body.sql ?? "").trim();
          if (!sql) return jsonRes({ error: "sql 为空" }, 400);
          const { data, error } = await db.rpc("ai_readonly_query" as never, {
            q: sql,
            max_rows: Number(body.max_rows ?? 2000) || 2000,
          } as never);
          if (error) return jsonRes({ error: error.message, details: error.details, hint: error.hint }, 400);
          const rows = (data ?? []) as unknown[];
          return jsonRes({ rows, row_count: rows.length });
        }
        if (body.action === "refresh_grants") {
          const { data, error } = await db.rpc("ai_reader_refresh_grants" as never);
          if (error) return jsonRes({ error: error.message }, 400);
          return jsonRes(data);
        }
        return jsonRes({ error: "未知 action" }, 400);
      },
    },
  },
});
