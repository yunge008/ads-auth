// GMV 归因 · 管理视图：全量进度板（含离职/6 桶口径）+ Excel 上传 + 审查与飞书回写。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RotateCw, Users, Target as TargetIcon, ArrowLeftRight, Upload, Download } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { ProgressBoard } from "@/components/attribution/ProgressBoard";
import { DetailTable } from "@/components/attribution/DetailTable";
import { ReviewPanel } from "@/components/attribution/ReviewPanel";
import { UploadView, type Viewing } from "@/components/attribution/UploadView";
import {
  type AttributionReport,
  type DetailRow,
  type DrillFilter,
  lastMonth,
  exportApi,
  feishuAction,
  syncCreators,
  uploadApi,
} from "@/lib/attributionApi";


const VID_SUMMARY_HEADER = ["站点", "月份", "VID", "达人昵称", "PID", "SKU", "GMV", "消耗", "订单量", "ROI", "PV", "点击", "CTR", "CVR"];

export const Route = createFileRoute("/gmv-attribution-admin")({
  head: () => ({ meta: [{ title: "GMV 归因·管理 - TikTok授权工具" }] }),
  component: GmvAttributionAdminPage,
});

function MonthlyView() {
  const [month, setMonth] = React.useState(lastMonth());
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
      const r = await uploadApi.get({ month, merged: true });
      setReport(r.summary);
      setLastSyncedAt(r.last_synced_at ?? null);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [month]);

  const drill = async (f: DrillFilter) => {
    const title = f.bucket ? (f.bucket === "PRODUCT_CARD" ? "商品卡明细" : "无建联明细") : `${f.staff} 明细`;
    setDetail({ rows: [], title });
    setDetailLoading(true);
    try {
      const r = await uploadApi.get({ month, merged: true, detail_for: f });
      setDetail({ rows: r.detail_rows ?? [], title });
    } catch (e) {
      toast.error(`加载明细失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const exportVidSummary = async () => {
    setBusy("export");
    try {
      const { rows } = await exportApi.vidSummary(month);
      if (!rows.length) { toast.warning("没有可导出的数据"); return; }
      const aoa = [
        VID_SUMMARY_HEADER,
        ...rows.map((r) => [
          r.country, r.month, r.vid, r.account_name, r.product_id, r.sku,
          r.gmv, r.cost, r.orders, r.roi ?? "", r.pv, r.clicks, r.ctr ?? "", r.cvr ?? "",
        ]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "VID汇总");
      XLSX.writeFile(wb, `VID汇总-${month}.xlsx`);
      toast.success(`导出完成：${rows.length} 行`);
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
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
              <Button size="sm" variant="outline" onClick={exportVidSummary} disabled={!!busy || !report}>
                <Download className={`h-4 w-4 mr-1.5 ${busy === "export" ? "animate-spin" : ""}`} />导出唯一VID汇总
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">
        数据来源：Excel 上传归因（按月合并全部站点） · 最近一次上传归因时间：{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "—"}
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

function UploadResultView() {
  const [result, setResult] = React.useState<{ viewing: Viewing; summary: AttributionReport } | null>(null);
  const [detail, setDetail] = React.useState<{ rows: DetailRow[]; title: string } | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [tab, setTab] = React.useState("monthly");

  const onResult = React.useCallback((r: { viewing: Viewing; summary: AttributionReport } | null) => {
    setResult(r);
    setDetail(null);
    if (r) setTab("result");
  }, []);

  const drill = async (f: DrillFilter) => {
    if (!result) return;
    const title = f.bucket ? (f.bucket === "PRODUCT_CARD" ? "商品卡明细" : "无建联明细") : `${f.staff} 明细`;
    setDetail({ rows: [], title });
    setDetailLoading(true);
    try {
      const v = result.viewing;
      const r = v.kind === "upload"
        ? await uploadApi.get({ upload_id: v.id, detail_for: f })
        : await uploadApi.get({ month: v.month, merged: true, detail_for: f });
      setDetail({ rows: r.detail_rows ?? [], title });
    } catch (e) {
      toast.error(`加载明细失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="monthly">月度进度</TabsTrigger>
        <TabsTrigger value="upload">Excel 上传</TabsTrigger>
        <TabsTrigger value="review">审查与回写</TabsTrigger>
        <TabsTrigger value="result">归因结果</TabsTrigger>
      </TabsList>
      <TabsContent value="monthly" className="mt-4">
        <MonthlyView />
      </TabsContent>
      <TabsContent value="upload" className="mt-4">
        <UploadView onResult={onResult} />
      </TabsContent>
      <TabsContent value="review" className="mt-4">
        <ReviewPanel />
      </TabsContent>
      <TabsContent value="result" className="mt-4 space-y-4">
        {result ? (
          <>
            <div className="text-sm font-medium">
              归因结果：{result.viewing.kind === "upload" ? result.viewing.label : `${result.viewing.month} 全站点合并`}
            </div>
            <ProgressBoard report={result.summary} mode="admin" onDrill={drill} />
            {detail ? <DetailTable rows={detail.rows} loading={detailLoading} title={detail.title} /> : null}
          </>
        ) : (
          <div className="text-sm text-muted-foreground text-center py-16">
            在「Excel 上传」中上传文件或点击历史记录查看，结果会显示在这里
          </div>
        )}
      </TabsContent>
    </Tabs>
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
      <UploadResultView />
    </div>
  );
}

