// GMV 归因 · 用户视图：在职同事按站点归因 GMV + KPI 进度（单站点低于阈值不计入）。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { ProgressBoard } from "@/components/attribution/ProgressBoard";
import { type AttributionReport, currentMonth, runAttribution } from "@/lib/attributionApi";

export const Route = createFileRoute("/gmv-attribution")({
  head: () => ({ meta: [{ title: "GMV 归因 - TikTok授权工具" }] }),
  component: GmvAttributionPage,
});

function GmvAttributionPage() {
  const [month, setMonth] = React.useState(currentMonth());
  const [report, setReport] = React.useState<AttributionReport | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    try {
      const r = await runAttribution(month, "user");
      setReport(r.report);
      setLastSyncedAt(r.last_synced_at);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [month]);

  React.useEffect(() => { load(); }, []); // 首次自动加载

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">GMV 归因</h2>
          <p className="text-sm text-muted-foreground mt-1">月度归因进度 · 数据来源：GMV Max 自动同步</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">月份</span>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
          </div>
          <Button size="sm" onClick={load} disabled={loading}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />查询
          </Button>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>数据最近刷新</span>
            <span className="tabular-nums">{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "—"}</span>
          </div>
        </div>
      </div>

      {loading && !report ? (
        <div className="text-sm text-muted-foreground text-center py-16">归因计算中…</div>
      ) : report ? (
        <ProgressBoard report={report} mode="user" />
      ) : null}
    </div>
  );
}
