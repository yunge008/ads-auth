// GMV 归因：读取 Excel 上传归因（按月合并全部站点），管理者视角查看全部同事（含离职）归因 GMV。
// 不做 2000 美元 KPI 阈值相关的过滤/展示，只呈现归因结果本身；同事专属查看页留待后续单独加 tab。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { UnmatchedTrendTable } from "@/components/attribution/UnmatchedTrendTable";
import { type AttributionReport, type StaffAgg, currentMonth, fmtUsd, uploadApi } from "@/lib/attributionApi";

export const Route = createFileRoute("/gmv-attribution")({
  head: () => ({ meta: [{ title: "GMV 归因 - TikTok授权工具" }] }),
  component: GmvAttributionPage,
});

function StaffTable({ title, rows }: { title: string; rows: StaffAgg[] }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}（{rows.length}）</h3>
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">GMV（USD）</TableHead>
              <TableHead>按站点</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={`${s.staff_name}|${s.role}`}>
                <TableCell className="font-medium">{s.staff_name}</TableCell>
                <TableCell><Badge variant={s.role === "BD" ? "default" : "secondary"}>{s.role === "BD" ? "BD" : "剪辑"}</Badge></TableCell>
                <TableCell>{s.active ? <Badge variant="outline">在职</Badge> : <Badge variant="outline">已离职</Badge>}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">${fmtUsd(s.gmv)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {s.by_country.map((c) => (
                      <span key={c.country} className="text-xs rounded px-1.5 py-0.5 border bg-muted/60 tabular-nums">
                        {c.country} ${fmtUsd(c.gmv)}
                      </span>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function UnmatchedSection({ report, month }: { report: AttributionReport; month: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">无建联达人</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="top">
          <TabsList>
            <TabsTrigger value="top">TOP（当月，按GMV）</TabsTrigger>
            <TabsTrigger value="trend">近12个月趋势表</TabsTrigger>
          </TabsList>
          <TabsContent value="top" className="mt-3">
            {report.unmatched.top.length ? (
              <div className="flex flex-wrap gap-1.5">
                {report.unmatched.top.slice(0, 30).map((t) => (
                  <span key={t.account_name} className="text-xs rounded px-1.5 py-0.5 border tabular-nums bg-muted/40">
                    {t.account_name} ${fmtUsd(t.gmv)}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-6">暂无数据</div>
            )}
          </TabsContent>
          <TabsContent value="trend" className="mt-3">
            <UnmatchedTrendTable month={month} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

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

  const bds = (report?.staff ?? []).filter((s) => s.role === "BD" && s.staff_name?.trim() && s.gmv > 0);
  const editors = (report?.staff ?? []).filter((s) => s.role === "EDITOR" && s.staff_name?.trim() && s.gmv > 0);

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
          <StaffTable title="BD" rows={bds} />
          <StaffTable title="剪辑" rows={editors} />
          {!bds.length && !editors.length ? (
            <div className="text-sm text-muted-foreground text-center py-8">暂无归因数据</div>
          ) : null}
          <UnmatchedSection report={report} month={month} />
        </div>
      ) : null}
    </div>
  );
}
