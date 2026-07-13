// GMV 归因 · 管理视图：全量进度板（含离职/6 桶口径）+ Excel 上传 + 审查与飞书回写。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RotateCw, Users, Target as TargetIcon, ArrowLeftRight, Upload } from "lucide-react";
import { toast } from "sonner";
import { ProgressBoard } from "@/components/attribution/ProgressBoard";
import { DetailTable } from "@/components/attribution/DetailTable";
import { ReviewPanel } from "@/components/attribution/ReviewPanel";
import { UploadView } from "@/components/attribution/UploadView";
import {
  type AttributionReport,
  type DetailRow,
  type DrillFilter,
  currentMonth,
  feishuAction,
  runAttribution,
  syncCreators,
} from "@/lib/attributionApi";

export const Route = createFileRoute("/gmv-attribution-admin")({
  head: () => ({ meta: [{ title: "GMV 归因·管理 - TikTok授权工具" }] }),
  component: GmvAttributionAdminPage,
});

function MonthlyView() {
  const [month, setMonth] = React.useState(currentMonth());
  const [report, setReport] = React.useState<AttributionReport | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<{ rows: DetailRow[]; title: string } | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    setDetail(null);
    try {
      const r = await runAttribution(month, "admin");
      setReport(r.report);
      setLastSyncedAt(r.last_synced_at);
      if (r.persisted && (r.persisted.aliases || r.persisted.reviews)) {
        toast.info(`本次运行：新别名 ${r.persisted.aliases} 个 · 审查项 ${r.persisted.reviews} 条`);
      }
    } catch (e) {
      toast.error(`归因失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [month]);

  const drill = async (f: DrillFilter) => {
    const title = f.bucket ? (f.bucket === "PRODUCT_CARD" ? "商品卡明细" : "无建联明细") : `${f.staff} 明细`;
    setDetail({ rows: [], title });
    setDetailLoading(true);
    try {
      const r = await runAttribution(month, "admin", f);
      setDetail({ rows: r.detail_rows ?? [], title });
    } catch (e) {
      toast.error(`加载明细失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const doSync = async (kind: "creators" | "targets" | "handovers" | "progress") => {
    setBusy(kind);
    try {
      if (kind === "creators") {
        const r = await syncCreators();
        toast.success(`达人登记同步完成：登记 ${r.registry_rows} 行 · 归属 ${r.ownership_keys} 键 · 待审查 ${r.reviews_open}`);
        if (r.missing_sheets.length) toast.warning(`缺少 sheet：${r.missing_sheets.join("、")}`);
      } else if (kind === "targets") {
        const r = await feishuAction<{ upserted: number; skipped: string[] }>("sync-targets");
        toast.success(`目标同步完成：${r.upserted} 条`);
        if (r.skipped?.length) toast.warning(`跳过：${r.skipped.join("；")}`);
      } else if (kind === "handovers") {
        const r = await feishuAction<{ synced: number; skipped: string[] }>("sync-handovers");
        toast.success(`站点交接同步完成：${r.synced} 条`);
        if (r.skipped?.length) toast.warning(`跳过：${r.skipped.join("；")}`);
      } else {
        const r = await feishuAction<{ appended: number }>("write-progress", { month });
        toast.success(`已回写飞书「归因进度」：${r.appended} 行快照`);
      }
    } catch (e) {
      toast.error(`操作失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">数据准备</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="outline" onClick={() => doSync("creators")} disabled={!!busy}>
            <Users className={`h-4 w-4 mr-1.5 ${busy === "creators" ? "animate-pulse" : ""}`} />同步达人登记（建联+归档+剪辑）
          </Button>
          <Button size="sm" variant="outline" onClick={() => doSync("targets")} disabled={!!busy}>
            <TargetIcon className="h-4 w-4 mr-1.5" />同步 GMV 目标
          </Button>
          <Button size="sm" variant="outline" onClick={() => doSync("handovers")} disabled={!!busy}>
            <ArrowLeftRight className="h-4 w-4 mr-1.5" />同步站点交接
          </Button>
          <div className="flex flex-col gap-1 ml-auto">
            <span className="text-xs text-muted-foreground">月份</span>
            <div className="flex items-center gap-2">
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
              <Button size="sm" onClick={load} disabled={loading}>
                <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />生成报表
              </Button>
              <Button size="sm" variant="outline" onClick={() => doSync("progress")} disabled={!!busy || !report}>
                <Upload className="h-4 w-4 mr-1.5" />回写飞书进度
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">
        数据最近刷新：{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "—"}（GMV Max 自动同步）
      </div>

      {loading && !report ? (
        <div className="text-sm text-muted-foreground text-center py-16">归因计算中…</div>
      ) : report ? (
        <>
          <ProgressBoard report={report} mode="admin" onDrill={drill} />
          {detail ? <DetailTable rows={detail.rows} loading={detailLoading} title={detail.title} /> : null}
        </>
      ) : (
        <div className="text-sm text-muted-foreground text-center py-16">选择月份后点击「生成报表」</div>
      )}
    </div>
  );
}

function GmvAttributionAdminPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">GMV 归因 · 管理</h2>
        <p className="text-sm text-muted-foreground mt-1">
          全量口径（含离职）：商品卡 / 剪辑VID / BD-VID / BD-昵称 / BD-模糊 / 无建联 · 一行数据只归一个人
        </p>
      </div>
      <Tabs defaultValue="monthly">
        <TabsList>
          <TabsTrigger value="monthly">月度进度</TabsTrigger>
          <TabsTrigger value="upload">Excel 上传</TabsTrigger>
          <TabsTrigger value="review">审查与回写</TabsTrigger>
        </TabsList>
        <TabsContent value="monthly" className="mt-4">
          <MonthlyView />
        </TabsContent>
        <TabsContent value="upload" className="mt-4">
          <UploadView />
        </TabsContent>
        <TabsContent value="review" className="mt-4">
          <ReviewPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
