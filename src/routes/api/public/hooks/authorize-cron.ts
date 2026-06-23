// Cron entrypoint for daily auto-authorize at 北京 08:00.
// Replicates the manual flow on `/`: feishu-read → authorize-batch (loop until
// nothing actionable remains, max 4 rounds / 10 min) → feishu-writeback → Feishu
// bot notification → upsert authorize_cron_state.
//
// Auth: requires `apikey: <SUPABASE_PUBLISHABLE_KEY>` header (pg_cron passes it).
// Downstream edge fns are called with `x-cron-key` (vault secret) which they
// verify via verify_gmv_cron_key RPC to bypass the admin passcode.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const HARD_BUDGET_MS = 10 * 60 * 1000;
const MAX_ROUNDS = 4;
const TIMEZONE_OFFSET_MINUTES = 8 * 60; // CST
const RECORDS_LINK =
  "https://lnihysziqd.feishu.cn/sheets/ZWA7s1iqTh63j1t6PJfcuPnunBe?sheet=1SBV4u&rangeId=1SBV4u_pPvTdlNlkj&rangeVer=1";

type Material = {
  id: string;
  sheet_name: string;
  row_number: number;
  country?: string;
  creator_name?: string;
  vid?: string;
  auth_code?: string;
  product?: string;
  staff_name: string;
  advertiser_id?: string;
  advertiser_name?: string;
  status: string;
  error_message?: string;
};

type AuthResult = { id: string; status: string; error_message?: string };

const WRITE_STATUSES = new Set([
  "已授权",
  "代码过期",
  "代码删除",
  "代码有误",
  "代码涉及多素材",
  "视频不可见",
  "API错误",
]);

function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}
function beijingNowLabel(): string {
  const ms = Date.now() + TIMEZONE_OFFSET_MINUTES * 60_000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function postFeishuBot(payload: unknown): Promise<void> {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) {
    console.warn("[authorize-cron] FEISHU_BOT_WEBHOOK not set, skip notification");
    return;
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn(`[authorize-cron] feishu bot HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[authorize-cron] feishu bot fetch failed: ${(e as Error).message}`);
  }
}

function buildSummaryPost(args: {
  title: string;
  lines: string[];
  withLink?: boolean;
}): unknown {
  const content: Array<Array<{ tag: string; text?: string; href?: string }>> = args.lines.map((t) => [
    { tag: "text", text: t },
  ]);
  if (args.withLink) {
    content.push([{ tag: "a", text: "查看授权记录", href: RECORDS_LINK }]);
  }
  return {
    msg_type: "post",
    content: { post: { zh_cn: { title: args.title, content } } },
  };
}

export const Route = createFileRoute("/api/public/hooks/authorize-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey =
          process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

        // 1. Verify caller
        const callerKey =
          request.headers.get("apikey") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        if (!anonKey || callerKey !== anonKey) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const admin = createClient(supabaseUrl, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });

        // 2. Vault cron key via SECURITY DEFINER RPC (vault schema is not
        // exposed through PostgREST, so direct table reads fail even with
        // service role).
        const { data: cronKey, error: secretErr } = await admin.rpc("get_gmv_cron_secret");
        if (secretErr || !cronKey) {
          return new Response(
            JSON.stringify({
              error: "missing vault secret gmv_max_cron_secret",
              detail: secretErr?.message,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const fnHeaders = {
          "Content-Type": "application/json",
          "x-cron-key": cronKey,
          "x-admin-name": "cron",
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        };

        const startedAt = Date.now();
        const errors: Array<{ stage: string; error: string }> = [];
        let rounds = 0;

        try {
          // 3. Active staff
          const { data: staffRows, error: staffErr } = await admin
            .from("staff_sheets")
            .select("name, sheet_name")
            .eq("active", true);
          if (staffErr) throw new Error(`staff_sheets: ${staffErr.message}`);
          const staff = (staffRows ?? []).filter((s) => s.name && s.sheet_name);
          if (staff.length === 0) {
            const payload = buildSummaryPost({
              title: `📋 自动授权（${beijingNowLabel()}）`,
              lines: ["⚠️ 未配置启用人员，跳过本次执行"],
            });
            await postFeishuBot(payload);
            await admin.from("authorize_cron_state").upsert({
              id: "daily",
              last_run_at: new Date().toISOString(),
              success: 0,
              failed: 0,
              no_account: 0,
              rounds: 0,
              errors: [],
              note: "no active staff",
            });
            return Response.json({ ok: true, skipped: "no_staff" });
          }

          // 4. feishu-read
          const readUrl = `${supabaseUrl}/functions/v1/feishu-read`;
          const readResp = await fetch(readUrl, {
            method: "POST",
            headers: fnHeaders,
            body: JSON.stringify({ staff, include_done: false }),
          });
          if (!readResp.ok) {
            throw new Error(`feishu-read HTTP ${readResp.status}: ${(await readResp.text()).slice(0, 300)}`);
          }
          const readJson = (await readResp.json()) as { materials?: Material[] };
          const materials = readJson.materials ?? [];

          const isActionable = (m: Material) =>
            (m.status === "待授权" || m.status === "API错误") &&
            !!m.advertiser_id &&
            !!m.auth_code;

          // 5. Nothing to do?
          if (!materials.some(isActionable)) {
            const payload = buildSummaryPost({
              title: `📋 自动授权（${beijingNowLabel()}）`,
              lines: ["今日无待授权素材"],
            });
            await postFeishuBot(payload);
            const noActionNote = `read ${materials.length} rows; none actionable`;
            const noAcct = materials.filter((m) => m.status === "无授权账号").length;
            await admin.from("authorize_cron_state").upsert({
              id: "daily",
              last_run_at: new Date().toISOString(),
              success: 0,
              failed: 0,
              no_account: noAcct,
              rounds: 0,
              errors: [],
              note: noActionNote,
            });
            await admin.from("authorize_log").insert({
              source: "cron",
              success: 0,
              failed: 0,
              no_account: noAcct,
              errors: [],
              note: noActionNote,
            });
            return Response.json({ ok: true, skipped: "no_actionable", read: materials.length });
          }

          // 6. Authorize loop (max 4 rounds / 10 min)
          const authUrl = `${supabaseUrl}/functions/v1/authorize-batch`;
          const byId = new Map(materials.map((m) => [m.id, m]));

          while (rounds < MAX_ROUNDS && Date.now() - startedAt < HARD_BUDGET_MS) {
            const targets = materials.filter(isActionable);
            if (targets.length === 0) break;
            rounds++;
            const r = await fetch(authUrl, {
              method: "POST",
              headers: fnHeaders,
              body: JSON.stringify({
                items: targets.map((t) => ({
                  id: t.id,
                  advertiser_id: t.advertiser_id,
                  auth_code: t.auth_code,
                  vid: t.vid,
                })),
              }),
            });
            if (!r.ok) {
              errors.push({
                stage: `authorize-batch round ${rounds}`,
                error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`,
              });
              break;
            }
            const j = (await r.json()) as { results?: AuthResult[] };
            for (const res of j.results ?? []) {
              const m = byId.get(res.id);
              if (m) {
                m.status = res.status;
                m.error_message = res.error_message;
              }
            }
          }
          if (Date.now() - startedAt >= HARD_BUDGET_MS) {
            errors.push({ stage: "loop", error: `budget exceeded at round ${rounds}` });
          }

          // 7. feishu-writeback
          const writeTargets = materials.filter((m) => WRITE_STATUSES.has(m.status));
          if (writeTargets.length > 0) {
            const wUrl = `${supabaseUrl}/functions/v1/feishu-writeback`;
            const wr = await fetch(wUrl, {
              method: "POST",
              headers: fnHeaders,
              body: JSON.stringify({
                items: writeTargets.map((m) => ({
                  sheet_name: m.sheet_name,
                  row_number: m.row_number,
                  status: m.status,
                  error_message: m.error_message,
                  country: m.country,
                  creator_name: m.creator_name,
                  vid: m.vid,
                  auth_code: m.auth_code,
                  product: m.product,
                  staff_name: m.staff_name,
                })),
              }),
            });
            if (!wr.ok) {
              errors.push({
                stage: "feishu-writeback",
                error: `HTTP ${wr.status}: ${(await wr.text()).slice(0, 300)}`,
              });
            }
          }

          // 8. Stats
          const success = materials.filter((m) => m.status === "已授权").length;
          const no_account = materials.filter((m) => m.status === "无授权账号").length;
          const failedRows = materials.filter(
            (m) => WRITE_STATUSES.has(m.status) && m.status !== "已授权",
          );
          const failed = failedRows.length;
          const breakdown = new Map<string, number>();
          for (const m of failedRows) breakdown.set(m.status, (breakdown.get(m.status) ?? 0) + 1);

          // 9. Feishu notification
          const lines = [
            `✅ 成功 ${success} 条 ｜ ❌ 失败 ${failed} 条 ｜ ⚠️ 无授权账号 ${no_account} 条`,
          ];
          if (failed > 0) {
            const parts = [...breakdown.entries()].map(([k, v]) => `${k} ×${v}`).join("、");
            lines.push(`失败原因：${parts}`);
          }
          const payload = buildSummaryPost({
            title: `📋 自动授权完成（${beijingNowLabel()}）`,
            lines,
            withLink: failed > 0,
          });
          await postFeishuBot(payload);

          // 10. Persist state
          const cronNote = `read=${materials.length} rounds=${rounds} elapsed_ms=${Date.now() - startedAt}`;
          await admin.from("authorize_cron_state").upsert({
            id: "daily",
            last_run_at: new Date().toISOString(),
            success,
            failed,
            no_account,
            rounds,
            errors: errors.slice(0, 20),
            note: cronNote,
          });
          await admin.from("authorize_log").insert({
            source: "cron",
            success,
            failed,
            no_account,
            errors: errors.slice(0, 20),
            note: cronNote,
          });

          return Response.json({
            ok: errors.length === 0,
            read: materials.length,
            success,
            failed,
            no_account,
            rounds,
            errors: errors.slice(0, 20),
            elapsed_ms: Date.now() - startedAt,
          });
        } catch (e) {
          const msg = (e as Error).message;
          console.error("[authorize-cron] fatal", e);
          errors.push({ stage: "fatal", error: msg });
          const payload = buildSummaryPost({
            title: `📋 自动授权失败（${beijingNowLabel()}）`,
            lines: [`❌ ${msg.slice(0, 200)}`],
          });
          await postFeishuBot(payload);
          await admin.from("authorize_cron_state").upsert({
            id: "daily",
            last_run_at: new Date().toISOString(),
            success: 0,
            failed: 0,
            no_account: 0,
            rounds,
            errors: errors.slice(0, 20),
            note: `fatal: ${msg.slice(0, 200)}`,
          });
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
