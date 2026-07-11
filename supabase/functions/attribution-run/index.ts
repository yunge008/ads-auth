// 月度 GMV 归因报表：gmv_max_vid_daily 按月聚合（RPC）→ 归因引擎 → 汇总。
// Body: { month: 'YYYY-MM', view?: 'admin'|'user', detail_for?: { staff?: string, role?: 'BD'|'EDITOR', bucket?: 'PRODUCT_CARD'|'UNMATCHED' } }
// view=user：仅在职同事、同事×站点 < 阈值的格子隐藏且不计 KPI；view=admin：全量（含离职）+ 6 桶明细。
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { applyUserView, buildMonthlyReport } from "../_shared/attribution-report.ts";

const DETAIL_CAP = 5000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = (await req.json()) as {
      month: string;
      view?: "admin" | "user";
      detail_for?: { staff?: string; role?: "BD" | "EDITOR"; bucket?: "PRODUCT_CARD" | "UNMATCHED" };
    };
    const view = body.view === "user" ? "user" : "admin";
    await checkAdminPasscode(req, view === "user" ? "gmv-attribution" : "gmv-attribution-admin");
    if (!body.month) throw new Error("month 必填（YYYY-MM）");

    const db = admin();
    const { report, detail, persisted } = await buildMonthlyReport(db, body.month);

    let detailRows: unknown[] | undefined;
    if (view === "admin" && body.detail_for) {
      const f = body.detail_for;
      detailRows = detail
        .filter(({ result }) => {
          if (f.bucket) return result.bucket === f.bucket;
          if (f.staff) {
            return (
              result.bucket === "STAFF" &&
              result.staff === f.staff &&
              (!f.role || result.source === f.role)
            );
          }
          return false;
        })
        .sort((a, b) => b.input.grossRevenue - a.input.grossRevenue)
        .slice(0, DETAIL_CAP)
        .map(({ input, result, activeDays }) => ({
          vid: input.vid,
          account_name: input.accountName,
          country: result.country,
          creative_type: input.creativeType,
          gmv: input.grossRevenue,
          cost: input.cost,
          orders: input.orders,
          currency: input.currency,
          active_days: activeDays,
          bucket: result.bucket,
          staff: result.staff ?? null,
          source: result.source ?? null,
          match_type: result.matchType ?? null,
          posted_at: input.postedAt,
          posted_at_source: input.postedAtSource,
          handover_applied: result.handoverApplied ?? false,
        }));
    }

    const { data: stateRow } = await db
      .from("gmv_max_sync_state")
      .select("last_synced_at")
      .eq("id", "gmv_max_vid_daily")
      .maybeSingle();

    return new Response(
      JSON.stringify({
        report: view === "user" ? applyUserView(report) : report,
        detail_rows: detailRows,
        persisted,
        last_synced_at: (stateRow as { last_synced_at?: string } | null)?.last_synced_at ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("attribution-run", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
