import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { RotateCw, ChevronLeft, ChevronRight, Download, Scissors, Package, Database } from "lucide-react";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { MultiSelect } from "@/components/MultiSelect";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/material-performance")({
  head: () => ({ meta: [{ title: "素材成效 - TikTok授权工具" }] }),
  component: MaterialPerformancePage,
});

type Row = {
  country: string;
  staff_name: string;
  source_type: string;
  vid: string;
  item_group_id: string;
  merchant_sku: string;
  product_id: string;
  cost: number;
  gross_revenue: number;
  orders: number;
  product_impressions: number;
  product_clicks: number;
  roi: number | null;
  ctr: number | null;
  cvr: number | null;
};
type SeriesPoint = {
  stat_date: string;
  cost: number;
  gross_revenue: number;
  orders: number;
  product_impressions: number;
  product_clicks: number;
  roi: number | null;
  ctr: number | null;
  cvr: number | null;
};

const METRICS = [
  { key: "cost", label: "消耗", color: "#ef4444", axis: "left" as const, defaultOn: false },
  { key: "gross_revenue", label: "收入", color: "#10b981", axis: "left" as const, defaultOn: true },
  { key: "orders", label: "订单", color: "#3b82f6", axis: "right" as const, defaultOn: false },
  { key: "roi", label: "ROI", color: "#f59e0b", axis: "right" as const, defaultOn: true },
  { key: "ctr", label: "CTR", color: "#a855f7", axis: "right" as const, defaultOn: false },
  { key: "cvr", label: "CVR", color: "#ec4899", axis: "right" as const, defaultOn: false },
  { key: "product_impressions", label: "PV", color: "#6366f1", axis: "left" as const, defaultOn: false },
  { key: "product_clicks", label: "Click", color: "#06b6d4", axis: "right" as const, defaultOn: false },
];

const PAGE_SIZE = 50;
const fmtNum = (n: number) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (n: number | null) => (n == null ? "—" : (n * 100).toFixed(2) + "%");
const fmtRoi = (n: number | null) => (n == null ? "—" : n.toFixed(2));

function MaterialPerformancePage() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = React.useState(ago30);
  const [endDate, setEndDate] = React.useState(today);
  const [backfillStart, setBackfillStart] = React.useState(ago30);
  const [backfillEnd, setBackfillEnd] = React.useState(today);

  const [rows, setRows] = React.useState<Row[]>([]);
  const [series, setSeries] = React.useState<SeriesPoint[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const [fCountry, setFCountry] = React.useState<string[]>([]);
  const [fStaff, setFStaff] = React.useState<string[]>([]);
  const [fSource, setFSource] = React.useState<string[]>([]);
  const [fVid, setFVid] = React.useState("");
  const [fSku, setFSku] = React.useState("");
  const [fPid, setFPid] = React.useState("");

  const [enabledMetrics, setEnabledMetrics] = React.useState<string[]>(
    METRICS.filter((m) => m.defaultOn).map((m) => m.key),
  );
  const [page, setPage] = React.useState(1);

  const runQuery = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await invokeFn<{ rows: Row[]; series: SeriesPoint[] }>("gmv-max-query", {
        start_date: startDate,
        end_date: endDate,
        countries: fCountry.length ? fCountry : undefined,
        staff_names: fStaff.length ? fStaff : undefined,
        source_types: fSource.length ? fSource : undefined,
        vids: fVid.trim() ? fVid.split(/[\s,，]+/).filter(Boolean) : undefined,
        merchant_skus: fSku.trim() ? fSku.split(/[\s,，]+/).filter(Boolean) : undefined,
        product_ids: fPid.trim() ? fPid.split(/[\s,，]+/).filter(Boolean) : undefined,
      });
      setRows(r.rows ?? []);
      setSeries(r.series ?? []);
      setPage(1);
    } catch (e) {
      toast.error(`查询失败：${(e as Error).message}`);
    } finally { setLoading(false); }
  }, [startDate, endDate, fCountry, fStaff, fSource, fVid, fSku, fPid]);

  React.useEffect(() => { runQuery(); }, []); // initial load

  const countries = React.useMemo(() => Array.from(new Set(rows.map((r) => r.country).filter(Boolean))), [rows]);
  const staffs = React.useMemo(() => Array.from(new Set(rows.map((r) => r.staff_name).filter(Boolean))), [rows]);
  const sources = React.useMemo(() => Array.from(new Set(rows.map((r) => r.source_type).filter(Boolean))), [rows]);

  const paged = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  const doSync = async (fn: string, body: Record<string, unknown> = {}, label: string) => {
    setBusy(label);
    try {
      const r = await invokeFn<Record<string, unknown>>(fn, body);
      const summary = Object.entries(r)
        .filter(([k]) => k !== "errors")
        .map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`)
        .join(" / ");
      toast.success(`${label} 完成：${summary}`);
      const errs = (r as { errors?: { error: string }[] }).errors;
      if (errs?.length) toast.warning(`${errs.length} 条错误：${errs[0].error}`);
    } catch (e) {
      toast.error(`${label} 失败：${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  const exportCsv = () => {
    const headers = [
      "国家", "同事", "来源", "VID", "商品ID", "商家SKU",
      "消耗", "收入", "订单", "展现", "点击", "ROI", "CTR", "CVR",
    ];
    const csv = [headers.join(",")]
      .concat(rows.map((r) => [
        r.country, r.staff_name, r.source_type, r.vid, r.item_group_id, r.merchant_sku,
        r.cost, r.gross_revenue, r.orders, r.product_impressions, r.product_clicks,
        r.roi ?? "", r.ctr ?? "", r.cvr ?? "",
      ].map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",")))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `material-performance-${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">素材成效</h2>
          <p className="text-sm text-muted-foreground mt-1">GMV Max VID 维度数据 · 关联剪辑/BD 飞书表与 SKU 匹配表</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => doSync("feishu-read-editors", {}, "同步剪辑表")}>
            <Scissors className={`h-4 w-4 mr-1.5 ${busy === "同步剪辑表" ? "animate-spin" : ""}`} />同步剪辑表
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => doSync("feishu-read-bd-vids", {}, "同步BD表")}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${busy === "同步BD表" ? "animate-spin" : ""}`} />同步BD表VID
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => doSync("feishu-read-sku", {}, "同步SKU匹配表")}>
            <Package className={`h-4 w-4 mr-1.5 ${busy === "同步SKU匹配表" ? "animate-spin" : ""}`} />同步SKU匹配表
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => {
            const end = today;
            const start = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
            doSync("gmv-max-sync", { start_date: start, end_date: end }, "拉取最近3天");
          }}>
            <Database className={`h-4 w-4 mr-1.5 ${busy === "拉取最近3天" ? "animate-spin" : ""}`} />拉取最近3天
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">首次回溯拉取（GMV Max）</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">起始日期</span>
            <Input type="date" value={backfillStart} onChange={(e) => setBackfillStart(e.target.value)} className="h-8 w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">结束日期</span>
            <Input type="date" value={backfillEnd} onChange={(e) => setBackfillEnd(e.target.value)} className="h-8 w-40" />
          </div>
          <Button size="sm" disabled={!!busy} onClick={() => doSync("gmv-max-sync", { start_date: backfillStart, end_date: backfillEnd }, "首次回溯拉取")}>
            <Database className={`h-4 w-4 mr-1.5 ${busy === "首次回溯拉取" ? "animate-spin" : ""}`} />开始回溯
          </Button>
          <p className="text-xs text-muted-foreground ml-2">超过 30 天自动按 30 天窗口拆分。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 space-y-3">
          <CardTitle className="text-base">筛选与查询</CardTitle>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">起始</span>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">结束</span>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-8 w-40" />
            </div>
            <MultiSelect label="国家" options={countries} value={fCountry} onChange={setFCountry} />
            <MultiSelect label="同事" options={staffs} value={fStaff} onChange={setFStaff} />
            <MultiSelect label="来源" options={sources} value={fSource} onChange={setFSource} />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">VID</span>
              <Input value={fVid} onChange={(e) => setFVid(e.target.value)} placeholder="可多个，逗号分隔" className="h-8 w-48" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">商家SKU</span>
              <Input value={fSku} onChange={(e) => setFSku(e.target.value)} placeholder="可多个" className="h-8 w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">商品ID</span>
              <Input value={fPid} onChange={(e) => setFPid(e.target.value)} placeholder="可多个" className="h-8 w-40" />
            </div>
            <Button size="sm" onClick={runQuery} disabled={loading}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />查询
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="h-4 w-4 mr-1.5" />导出CSV
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="pb-3 space-y-2">
          <CardTitle className="text-base">日趋势图</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            {METRICS.map((m) => (
              <label key={m.key} className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox
                  checked={enabledMetrics.includes(m.key)}
                  onCheckedChange={(v) => {
                    setEnabledMetrics((prev) =>
                      v ? Array.from(new Set([...prev, m.key])) : prev.filter((x) => x !== m.key),
                    );
                  }}
                />
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: m.color }} />
                {m.label}
              </label>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="stat_date" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                {METRICS.filter((m) => enabledMetrics.includes(m.key)).map((m) => (
                  <Line
                    key={m.key}
                    yAxisId={m.axis}
                    type="monotone"
                    dataKey={m.key}
                    name={m.label}
                    stroke={m.color}
                    dot={false}
                    strokeWidth={2}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            汇总表 <span className="text-xs font-normal text-muted-foreground ml-1">（共 {rows.length} 行）</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>国家</TableHead>
                  <TableHead>同事</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>VID</TableHead>
                  <TableHead>商家SKU</TableHead>
                  <TableHead>商品ID</TableHead>
                  <TableHead className="text-right">订单</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">消耗</TableHead>
                  <TableHead className="text-right">收入</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">CVR</TableHead>
                  <TableHead className="text-right">展现</TableHead>
                  <TableHead className="text-right">点击</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={14} className="h-20 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
                ) : paged.length === 0 ? (
                  <TableRow><TableCell colSpan={14} className="h-20 text-center text-sm text-muted-foreground">暂无数据</TableCell></TableRow>
                ) : paged.map((r, i) => (
                  <TableRow key={`${r.country}-${r.staff_name}-${r.source_type}-${r.vid}-${r.item_group_id}-${i}`}>
                    <TableCell>{r.country || "—"}</TableCell>
                    <TableCell>{r.staff_name}</TableCell>
                    <TableCell className="text-xs">{r.source_type}</TableCell>
                    <TableCell className="font-mono text-xs">{r.vid}</TableCell>
                    <TableCell>{r.merchant_sku || "未匹配"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.item_group_id || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.orders)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRoi(r.roi)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.gross_revenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.ctr)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.cvr)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.product_impressions)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.product_clicks)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {rows.length > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
              <div>第 {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, rows.length)} / 共 {rows.length} 行</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
                <span>{page} / {pageCount}</span>
                <Button size="sm" variant="outline" className="h-7" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
