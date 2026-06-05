import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { RotateCw, ChevronLeft, ChevronRight, Download, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { MultiSelect } from "@/components/MultiSelect";
import { DateRangeQuickSelect } from "@/components/DateRangeQuickSelect";
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
  advertiser_id: string;
  advertiser_name: string;
  registered_sku: string;
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
  cpm: number | null;
  cpa: number | null;
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
  cpm: number | null;
  cpa: number | null;
};

const METRICS = [
  { key: "cost", label: "消耗", color: "#ef4444", axis: "left" as const, defaultOn: false },
  { key: "gross_revenue", label: "收入", color: "#10b981", axis: "left" as const, defaultOn: true },
  { key: "orders", label: "订单", color: "#3b82f6", axis: "right" as const, defaultOn: false },
  { key: "roi", label: "ROI", color: "#f59e0b", axis: "right" as const, defaultOn: true },
  { key: "ctr", label: "CTR", color: "#a855f7", axis: "right" as const, defaultOn: false },
  { key: "cvr", label: "CVR", color: "#ec4899", axis: "right" as const, defaultOn: false },
  { key: "cpm", label: "CPM", color: "#14b8a6", axis: "left" as const, defaultOn: false },
  { key: "cpa", label: "CPA", color: "#f97316", axis: "left" as const, defaultOn: false },
  { key: "product_impressions", label: "PV", color: "#6366f1", axis: "left" as const, defaultOn: false },
  { key: "product_clicks", label: "Click", color: "#06b6d4", axis: "right" as const, defaultOn: false },
];

const PAGE_SIZE = 20;
const fmtNum = (n: number) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (n: number | null) => (n == null ? "—" : (n * 100).toFixed(2) + "%");
const fmtRoi = (n: number | null) => (n == null ? "—" : n.toFixed(2));

function MaterialPerformancePage() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = React.useState(ago30);
  const [endDate, setEndDate] = React.useState(today);

  const [rows, setRows] = React.useState<Row[]>([]);
  const [series, setSeries] = React.useState<SeriesPoint[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

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
  const [sortKey, setSortKey] = React.useState<keyof Row | null>(null);
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const toggleSort = (k: keyof Row) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  };

  const runQuery = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await invokeFn<{ rows: Row[]; series: SeriesPoint[]; last_synced_at: string | null }>("gmv-max-query", {
        start_date: startDate,
        end_date: endDate,
      });
      setRows(r.rows ?? []);
      setSeries(r.series ?? []);
      setLastSyncedAt(r.last_synced_at ?? null);
      setPage(1);
    } catch (e) {
      toast.error(`查询失败：${(e as Error).message}`);
    } finally { setLoading(false); }
  }, [startDate, endDate]);

  React.useEffect(() => { runQuery(); }, []); // auto on mount

  const countries = React.useMemo(() => Array.from(new Set(rows.map((r) => r.country).filter(Boolean))), [rows]);
  const staffs = React.useMemo(() => Array.from(new Set(rows.map((r) => r.staff_name).filter(Boolean))), [rows]);
  const sources = React.useMemo(() => Array.from(new Set(rows.map((r) => r.source_type).filter(Boolean))), [rows]);

  const filteredRows = React.useMemo(() => {
    const vids = fVid.trim() ? fVid.split(/[\s,，]+/).filter(Boolean) : null;
    const skus = fSku.trim() ? fSku.split(/[\s,，]+/).filter(Boolean) : null;
    const pids = fPid.trim() ? fPid.split(/[\s,，]+/).filter(Boolean) : null;
    return rows.filter((r) => {
      if (fCountry.length && !fCountry.includes(r.country)) return false;
      if (fStaff.length && !fStaff.includes(r.staff_name)) return false;
      if (fSource.length && !fSource.includes(r.source_type)) return false;
      if (vids && !vids.some((v) => r.vid?.includes(v))) return false;
      if (skus && !skus.some((s) => r.merchant_sku?.includes(s))) return false;
      if (pids && !pids.some((p) => r.product_id?.includes(p))) return false;
      return true;
    });
  }, [rows, fCountry, fStaff, fSource, fVid, fSku, fPid]);

  React.useEffect(() => { setPage(1); }, [filteredRows.length]);

  const sortedRows = React.useMemo(() => {
    if (!sortKey) return filteredRows;
    const arr = [...filteredRows];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[sortKey] as unknown;
      const bv = b[sortKey] as unknown;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return arr;
  }, [filteredRows, sortKey, sortDir]);

  const totals = React.useMemo(() => {
    const t = { cost: 0, gross_revenue: 0, orders: 0, product_impressions: 0, product_clicks: 0 };
    for (const r of filteredRows) {
      t.cost += r.cost ?? 0;
      t.gross_revenue += r.gross_revenue ?? 0;
      t.orders += r.orders ?? 0;
      t.product_impressions += r.product_impressions ?? 0;
      t.product_clicks += r.product_clicks ?? 0;
    }
    const roi = t.cost > 0 ? t.gross_revenue / t.cost : null;
    const ctr = t.product_impressions > 0 ? t.product_clicks / t.product_impressions : null;
    const cvr = t.product_clicks > 0 ? t.orders / t.product_clicks : null;
    const cpm = t.product_impressions > 0 ? (t.cost / t.product_impressions) * 1000 : null;
    const cpa = t.orders > 0 ? t.cost / t.orders : null;
    return { ...t, roi, ctr, cvr, cpm, cpa };
  }, [filteredRows]);

  const paged = sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));


  const exportCsv = () => {
    const headers = [
      "国家", "广告户", "同事", "来源", "VID", "商品ID", "登记SKU", "商家SKU",
      "消耗", "收入", "订单", "展现", "点击", "ROI", "CTR", "CVR", "CPM", "CPA",
    ];
    const csv = [headers.join(",")]
      .concat(filteredRows.map((r) => [
        r.country, r.advertiser_name || r.advertiser_id, r.staff_name, r.source_type, r.vid, r.item_group_id, r.registered_sku, r.merchant_sku,
        r.cost, r.gross_revenue, r.orders, r.product_impressions, r.product_clicks,
        r.roi ?? "", r.ctr ?? "", r.cvr ?? "", r.cpm ?? "", r.cpa ?? "",
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
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">起始</span>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">结束</span>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-8 w-40" />
          </div>
          <DateRangeQuickSelect onPick={(s, e) => { setStartDate(s); setEndDate(e); }} />
          <Button size="sm" onClick={runQuery} disabled={loading}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />查询
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={filteredRows.length === 0}>
            <Download className="h-4 w-4 mr-1.5" />导出CSV
          </Button>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>最近刷新</span>
            <span className="tabular-nums">{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "—"}</span>
          </div>

        </div>
      </div>

      <Card>
        <CardHeader className="pb-3 space-y-3">
          <CardTitle className="text-base">筛选当前结果</CardTitle>
          <div className="flex flex-wrap items-end gap-2">
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
            {(fCountry.length || fStaff.length || fSource.length || fVid || fSku || fPid) ? (
              <Button size="sm" variant="ghost" onClick={() => { setFCountry([]); setFStaff([]); setFSource([]); setFVid(""); setFSku(""); setFPid(""); }}>
                清空筛选
              </Button>
            ) : null}
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
                <Tooltip
                  formatter={(value: number | string, name: string) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return [String(value), name];
                    if (name === "CTR" || name === "CVR") return [(n * 100).toFixed(2) + "%", name];
                    return [n.toFixed(2), name];
                  }}
                />
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
            汇总表 <span className="text-xs font-normal text-muted-foreground ml-1">（筛选后 {filteredRows.length} / 共 {rows.length} 行）</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>国家</TableHead>
                  <TableHead>广告户</TableHead>
                  <TableHead>同事</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>VID</TableHead>
                  <TableHead>登记SKU</TableHead>
                  <TableHead>商家SKU</TableHead>
                  <TableHead>商品ID</TableHead>

                  <TableHead className="text-right">订单</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">消耗</TableHead>
                  <TableHead className="text-right">收入</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">CVR</TableHead>
                  <TableHead className="text-right">CPM</TableHead>
                  <TableHead className="text-right">CPA</TableHead>
                  <TableHead className="text-right">展现</TableHead>
                  <TableHead className="text-right">点击</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={18} className="h-20 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
                ) : paged.length === 0 ? (
                  <TableRow><TableCell colSpan={18} className="h-20 text-center text-sm text-muted-foreground">暂无数据</TableCell></TableRow>
                ) : paged.map((r, i) => (
                  <TableRow key={`${r.country}-${r.staff_name}-${r.source_type}-${r.vid}-${r.item_group_id}-${r.advertiser_id}-${i}`}>
                    <TableCell>{r.country || "—"}</TableCell>
                    <TableCell className="text-xs" title={r.advertiser_id}>{r.advertiser_name || r.advertiser_id || "—"}</TableCell>
                    <TableCell>{r.staff_name}</TableCell>
                    <TableCell className="text-xs">{r.source_type}</TableCell>
                    <TableCell className="font-mono text-xs">{r.vid}</TableCell>
                    <TableCell>{r.registered_sku || "—"}</TableCell>
                    <TableCell>{r.merchant_sku || "未匹配"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.item_group_id || "—"}</TableCell>

                    <TableCell className="text-right tabular-nums">{fmtNum(r.orders)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRoi(r.roi)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.gross_revenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.ctr)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(r.cvr)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRoi(r.cpm)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtRoi(r.cpa)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.product_impressions)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.product_clicks)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>

            </Table>
          </div>
          {filteredRows.length > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
              <div>第 {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredRows.length)} / 共 {filteredRows.length} 行</div>
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
