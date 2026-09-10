// GMV 归因：读取 Excel 上传归因（按月合并全部站点），管理者视角查看全部同事（含离职）归因 GMV。
// 不做 2000 美元 KPI 阈值相关的过滤/展示，只呈现归因结果本身；同事专属查看页留待后续单独加 tab。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateCw, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { UnmatchedTrendTable } from "@/components/attribution/UnmatchedTrendTable";
import { StaffCountryTable } from "@/components/attribution/StaffCountryTable";
import { type AttributionReport, fmtUsd, snapshotApi } from "@/lib/attributionApi";
import { attributionView } from "@/lib/attributionView";

export const Route = createFileRoute("/gmv-attribution")({
  head: () => ({ meta: [{ title: "GMV 归因 - TikTok授权工具" }] }),
  component: GmvAttributionPage,
});

function UnmatchedSection({ month }: { report: AttributionReport; month: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">无建联达人（当月 GMV + 近 12 个月）</CardTitle>
      </CardHeader>
      <CardContent>
        <UnmatchedTrendTable month={month} />
      </CardContent>
    </Card>
  );
}

function GmvAttributionPage() {
  // 视图状态放模块级 store：切路由/切标签页回来不用重查（查一次要跑服务端）
  const views = React.useSyncExternalStore(
    attributionView.subscribe,
    attributionView.getSnapshot,
    attributionView.getServerSnapshot,
  );
  const view = views.user;
  const { month, report, run } = view;
  const setMonth = (m: string) => attributionView.patch("user", { month: m });
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  /** 默认读最新快照（秒开），不做即时全量重算。 */
  const load = React.useCallback(async (m: string) => {
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    setLoading(true);
    try {
      const r = await snapshotApi.report(m);
      attributionView.patch("user", { report: r.summary, run: r.run, loadedAt: Date.now() });
      if (!r.run) toast.info(`${m} 还没有归因快照，点「重新计算」生成一次（之后每晚会自动刷新）`);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  /** 手动重算：按当下的飞书登记数据重跑该月全站点全人员归因，生成一条新快照。 */
  const refresh = async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setRefreshing(true);
    try {
      const r = await snapshotApi.refresh(month);
      const first = r.results?.[0];
      if (first && !first.ok) throw new Error(first.error ?? "重算失败");
      toast.success(`${month} 归因快照已更新`);
      await load(month);
    } catch (e) {
      toast.error(`重新计算失败：${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  // 首次进入且还没查过时才自动加载；已有缓存就直接用
  const bootRef = React.useRef(false);
  React.useEffect(() => {
    if (bootRef.current || view.report) return;
    bootRef.current = true;
    load(view.month);
  }, [load, view.month, view.report]);

  const bds = (report?.staff ?? []).filter((s) => s.role === "BD" && s.staff_name?.trim());
  const editors = (report?.staff ?? []).filter((s) => s.role === "EDITOR" && s.staff_name?.trim());


  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">GMV 归因</h2>
          <p className="text-sm text-muted-foreground mt-1">
            月度归因进度 · 展示每晚自动刷新的归因快照；需要立刻用上最新的飞书登记数据时点「重新计算」
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">月份</span>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
          </div>
          <Button size="sm" onClick={() => load(month)} disabled={loading || refreshing}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />查询
          </Button>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading || refreshing} title="按当下的飞书登记数据重跑该月归因，生成一条新快照">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />重新计算
          </Button>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>归因快照时间</span>
            <span className="tabular-nums">
              {run?.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}
              {run ? `（${run.source === "CRON" ? "每晚自动" : run.source === "UPLOAD" ? "上传后" : "手动"}）` : ""}
            </span>
          </div>
        </div>
      </div>

      {refreshing ? (
        <div className="text-sm text-muted-foreground text-center py-16">正在重新计算该月全站点归因，请稍候…</div>
      ) : loading && !report ? (
        <div className="text-sm text-muted-foreground text-center py-16">读取归因快照…</div>
      ) : report ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 grid-cols-1">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-normal text-muted-foreground">总归因 GMV（USD）</CardTitle>
              </CardHeader>
              <CardContent className="text-xl font-semibold tabular-nums">${fmtUsd(report.totals.gmv)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-normal text-muted-foreground">统计范围</CardTitle>
              </CardHeader>
              <CardContent className="text-sm tabular-nums">{report.period.start} ~ {report.period.end}</CardContent>
            </Card>
          </div>
          <StaffCountryTable title="BD" rows={bds} mode="user" />
          <StaffCountryTable title="剪辑" rows={editors} mode="user" />

          {!bds.length && !editors.length ? (
            <div className="text-sm text-muted-foreground text-center py-8">暂无归因数据</div>
          ) : null}
          <UnmatchedSection report={report} month={month} />
        </div>
      ) : null}
    </div>
  );
}
