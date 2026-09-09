// GMV 归因：读取 Excel 上传归因（按月合并全部站点），管理者视角查看全部同事（含离职）归因 GMV。
// 2000 美元 KPI 阈值仅作展示提示，不自动隐藏/排除，由管理者自行判断是否计入。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { ProgressBoard } from "@/components/attribution/ProgressBoard";
import { type AttributionReport, currentMonth, uploadApi } from "@/lib/attributionApi";

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
      const r = await uploadApi.get({ month, merged: true });
      setReport(r.summary);
      setLastSyncedAt(r.last_synced_at ?? null);
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
          <p className="text-sm text-muted-foreground mt-1">月度归因进度 · 数据来源：Excel 上传归因（按月合并全部站点）</p>
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
            <span>最近一次上传归因时间</span>
            <span className="tabular-nums">{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "—"}</span>
          </div>
        </div>
      </div>

      {loading && !report ? (
        <div className="text-sm text-muted-foreground text-center py-16">归因计算中…</div>
      ) : report ? (
        <ProgressBoard report={report} mode="admin" />
      ) : null}
    </div>
  );
}
