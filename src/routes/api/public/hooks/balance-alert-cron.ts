// 账户余额预警：刷新 + 发飞书。
//
// 发送渠道 = FEISHU_BOT_WEBHOOK（与每日自动授权通知同一个群），这个 webhook 只配在服务端环境变量里，
// 所以消息由 Edge Function `balance-alert` 的 build_message 组装、本路由负责 POST 到 webhook。
//
// 两种调用：
//   ① pg_cron（每天北京 10:00）：`apikey: <SUPABASE_PUBLISHABLE_KEY>` 头 → 下游带 x-cron-key；
//      先同步 ECO 余额（src/lib/eco.server.ts）→ refresh（分片续跑到 remaining 为空）→ build_message，每天都发完整列表（交互卡片，绿/黄/红）。
//   ② 页面「发送到飞书」按钮：带 x-admin-passcode / x-admin-name，原样转给 Edge Function 校验（需 settings 权限）；
//      body `{ manual: true }`，不刷新，只按库里当前快照组装并强制发送（无预警也发一条，用于确认通道）。
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { db, ecoStatus, syncEcoBalances } from "@/lib/eco.server";

const HARD_BUDGET_MS = 8 * 60 * 1000;
const MAX_ROUNDS = 20;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function postFeishu(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.FEISHU_BOT_WEBHOOK;
  if (!url) throw new Error("服务端未配置 FEISHU_BOT_WEBHOOK");
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = (await r.json().catch(() => ({}))) as {
    code?: number;
    StatusCode?: number;
    msg?: string;
  };
  const code = j.code ?? j.StatusCode ?? (r.ok ? 0 : r.status);
  if (code !== 0) throw new Error(`飞书机器人发送失败 code=${code}: ${j.msg ?? ""}`);
}

/** 优先发交互卡片（带颜色）；Edge Function 是旧版没有 card 时退回纯文本 post */
async function postFeishuBot(msg: Record<string, unknown>): Promise<void> {
  if (msg.card) {
    await postFeishu({ msg_type: "interactive", card: msg.card });
    return;
  }
  const lines = (msg.lines as string[]) ?? [];
  await postFeishu({
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: String(msg.title ?? "账户余额预警"),
          content: lines.map((t) => [{ tag: "text", text: t }]),
        },
      },
    },
  });
}

// ---------- ECO 同步健康检查：失败绝不静默 ----------
// ECO 余额同步失败时，余额预警会沿用 24h 内的旧余额（或该批户算不出可用天数）；如果卡片上不标出来，
// 就会出现「余额其实快用光了但卡片显示正常」的情况。所以任何 ECO 异常都要把卡片头变红并置顶说明。
const ECO_STALE_HOURS = 26;
const bj = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "从未";

async function ecoProblem(
  syncResult: { ok: boolean; error?: string } | null,
): Promise<{ reason: string; lastOk: string | null } | null> {
  const st = await ecoStatus().catch((e) => ({ error: (e as Error).message }) as never);
  const s = st as Awaited<ReturnType<typeof ecoStatus>> & { error?: string };
  if (s.error) return { reason: `读取 ECO 同步状态失败：${s.error}`, lastOk: null };
  if (!s.configured)
    return { reason: "服务端未配置 ECO_USERNAME / ECO_PASSWORD", lastOk: s.sync_at };
  if (syncResult && !syncResult.ok) {
    return { reason: syncResult.error ?? "未知错误", lastOk: s.sync_at };
  }
  const failedLater =
    !!s.sync_error && (!s.sync_at || Date.parse(s.sync_error_at ?? "") > Date.parse(s.sync_at));
  if (failedLater) return { reason: s.sync_error ?? "未知错误", lastOk: s.sync_at };
  if (!s.sync_at) return { reason: "ECO 余额从未同步成功", lastOk: null };
  const ageH = (Date.now() - Date.parse(s.sync_at)) / 3600_000;
  if (ageH > ECO_STALE_HOURS)
    return { reason: `ECO 余额已 ${Math.floor(ageH)} 小时未成功同步`, lastOk: s.sync_at };
  return null;
}

function humanEcoReason(reason: string): string {
  if (reason.includes("ECO_2FA_REQUIRED"))
    return "ECO 要求二次验证 → 到「设置 → 账户余额预警」点「ECO 验证」完成一次";
  return reason.slice(0, 300);
}

/** 在卡片顶部插入红色警示、标题改红；无卡片（旧版 Edge Function）时在纯文本最前面加 */
function decorate(msg: Record<string, unknown>, warnings: string[]) {
  if (!warnings.length) return msg;
  const card = msg.card as
    | { header?: { template?: string; title?: { content?: string } }; elements?: unknown[] }
    | undefined;
  if (card) {
    card.header = card.header ?? {};
    card.header.template = "red";
    card.header.title = {
      ...(card.header.title ?? {}),
      tag: "plain_text",
      content: `⚠ 数据异常｜${card.header.title?.content ?? "账户余额预警"}`,
    } as never;
    card.elements = [
      {
        tag: "markdown",
        content: warnings.map((w) => `<font color='red'>**${w}**</font>`).join("\n"),
      },
      { tag: "hr" },
      ...(card.elements ?? []),
    ];
  }
  msg.lines = [...warnings, "", ...((msg.lines as string[]) ?? [])];
  msg.title = `⚠ 数据异常｜${String(msg.title ?? "账户余额预警")}`;
  return msg;
}

export const Route = createFileRoute("/api/public/hooks/balance-alert-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const body = (await request.json().catch(() => ({}))) as { manual?: boolean };
        const passcode = request.headers.get("x-admin-passcode") ?? "";
        const manual = !!body.manual && !!passcode;

        let authHeaders: Record<string, string>;
        if (manual) {
          authHeaders = {
            "x-admin-passcode": passcode,
            "x-admin-name": request.headers.get("x-admin-name") ?? "",
          };
        } else {
          const callerKey =
            request.headers.get("apikey") ??
            request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
            "";
          if (!anonKey || callerKey !== anonKey) return jsonRes({ error: "unauthorized" }, 401);
          const admin = createClient(supabaseUrl, serviceKey, {
            auth: { autoRefreshToken: false, persistSession: false },
          });
          const { data: cronKey, error: secretErr } = await admin.rpc("get_gmv_cron_secret");
          if (secretErr || !cronKey) {
            return jsonRes(
              { error: "missing vault secret gmv_max_cron_secret", detail: secretErr?.message },
              500,
            );
          }
          authHeaders = { "x-cron-key": cronKey as string };
        }

        const callFn = async (payload: Record<string, unknown>) => {
          const r = await fetch(`${supabaseUrl}/functions/v1/balance-alert`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
              ...authHeaders,
            },
            body: JSON.stringify(payload),
          });
          const text = await r.text();
          if (!r.ok) {
            let msg = text.slice(0, 400);
            try {
              msg = (JSON.parse(text) as { error?: string }).error ?? msg;
            } catch {
              /* keep raw */
            }
            throw new Error(msg);
          }
          return JSON.parse(text) as Record<string, unknown>;
        };

        const started = Date.now();
        let rounds = 0;
        let checked = 0;
        let remaining: string[] = [];
        try {
          // ECO 余额只能从这里（Cloudflare 出口）同步，Supabase 出口被 ECO 拦截；失败不阻断，预警里会注明
          const eco = manual ? null : await syncEcoBalances();
          if (!manual) {
            let first = true;
            do {
              const r = await callFn({
                action: "refresh",
                ...(first ? {} : { advertiser_ids: remaining }),
              });
              first = false;
              checked += Number(r.done ?? 0);
              remaining = (r.remaining as string[] | undefined) ?? [];
              rounds++;
            } while (
              remaining.length &&
              rounds < MAX_ROUNDS &&
              Date.now() - started < HARD_BUDGET_MS
            );
          }
          // 刷新超时没轮到的户：清空上次结果并注明，绝不在卡片里显示旧余额/旧可用天数
          if (!manual && remaining.length) {
            await db()
              .from("balance_alert_accounts")
              .update({
                balance: null,
                days_left: null,
                error: "本次定时刷新超时，该户未更新（未沿用旧数据），请到页面点「立即刷新」",
                checked_at: new Date().toISOString(),
              })
              .in("advertiser_id", remaining);
          }
          const msg = await callFn({ action: "build_message", force: true });
          const warnings: string[] = [];
          const ecoBad = await ecoProblem(eco);
          if (ecoBad) {
            warnings.push(
              `⚠ ECO 余额同步失败：${humanEcoReason(ecoBad.reason)}`,
              `ECO 代理户本次没有余额数据（未沿用 ${bj(ecoBad.lastOk)} 的旧余额），在列表中显示为「—」，请人工核对 ECO 后台`,
            );
          }
          if (!manual && remaining.length) {
            warnings.push(
              `⚠ 本次刷新超时，${remaining.length} 个账户未更新，已显示为「—」（未沿用旧数据）`,
            );
          }
          decorate(msg, warnings);
          // 每天必发：即使没有开启监控的账户，也发一条状态
          if (!msg.send) {
            msg.card = {
              config: { wide_screen_mode: true },
              header: {
                template: "grey",
                title: { tag: "plain_text", content: "账户余额预警：当前没有开启监控的账户" },
              },
              elements: [
                {
                  tag: "markdown",
                  content: `**数据时间**：${bj(new Date().toISOString())}\n请到「设置 → 账户余额预警」打开需要监控的账户。`,
                },
              ],
            };
            msg.title = "账户余额预警：当前没有开启监控的账户";
            msg.lines = [];
            decorate(msg, warnings);
            msg.send = true;
          }
          let sent = false;
          if (msg.send) {
            await postFeishuBot(msg);
            sent = true;
            const ids = (msg.alert_ids as string[]) ?? [];
            if (ids.length) await callFn({ action: "mark_alerted", advertiser_ids: ids });
          }
          const out = {
            ok: true,
            manual,
            rounds,
            checked,
            remaining: remaining.length,
            sent,
            eco,
            warnings: warnings.length,
            alerts: msg.alerts ?? 0,
            broken: msg.broken ?? 0,
            elapsed_ms: Date.now() - started,
          };
          console.log("[balance-alert-cron]", JSON.stringify(out));
          return jsonRes(out);
        } catch (e) {
          const err = (e as Error).message;
          console.error("[balance-alert-cron]", err);
          // 任务本身失败也必须通知，否则当天就没有任何预警
          try {
            await postFeishu({
              msg_type: "interactive",
              card: {
                config: { wide_screen_mode: true },
                header: {
                  template: "red",
                  title: { tag: "plain_text", content: "⚠ 账户余额预警任务失败，今日余额未更新" },
                },
                elements: [
                  {
                    tag: "markdown",
                    content: [
                      `**错误**：${err.slice(0, 400)}`,
                      `**进度**：已刷新 ${checked} 户 / ${rounds} 轮`,
                      `**时间**：${bj(new Date().toISOString())}`,
                      "请到「设置 → 账户余额预警」点「立即刷新」重试，并人工核对 ECO 后台余额。",
                    ].join("\n"),
                  },
                ],
              },
            });
          } catch (notifyErr) {
            console.error("[balance-alert-cron] 失败通知也发送失败", (notifyErr as Error).message);
          }
          return jsonRes({ ok: false, error: err, rounds, checked }, 500);
        }
      },
    },
  },
});
