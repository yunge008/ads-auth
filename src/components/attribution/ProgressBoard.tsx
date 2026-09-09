// 归因进度板：同事×站点表格 + （管理视图）商品卡/无建联桶与口径拆分。
import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StaffCountryTable } from "./StaffCountryTable";
import { UnmatchedTrendTable } from "./UnmatchedTrendTable";
import {
  type AttributionReport,
  type DrillFilter,
  fmtUsd,
} from "@/lib/attributionApi";


export function ProgressBoard({
  report,
  mode,
  onDrill,
}: {
  report: AttributionReport;
  mode: "admin" | "user";
  onDrill?: (f: DrillFilter) => void;
}) {
  const bds = report.staff.filter((s) => s.role === "BD");
  const editors = report.staff.filter((s) => s.role === "EDITOR");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4 grid-cols-2">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-normal text-muted-foreground">总归因 GMV（USD）</CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">${fmtUsd(report.totals.gmv)}</CardContent>
        </Card>
        {mode === "admin" ? (
          <>
            <Card className={onDrill ? "cursor-pointer hover:bg-muted/40" : ""} onClick={() => onDrill?.({ bucket: "PRODUCT_CARD" })}>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-normal text-muted-foreground">商品卡</CardTitle>
              </CardHeader>
              <CardContent className="text-xl font-semibold tabular-nums">${fmtUsd(report.product_card.gmv)}</CardContent>
            </Card>
            <Card className={onDrill ? "cursor-pointer hover:bg-muted/40" : ""} onClick={() => onDrill?.({ bucket: "UNMATCHED" })}>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-normal text-muted-foreground">无建联达人</CardTitle>
              </CardHeader>
              <CardContent className="text-xl font-semibold tabular-nums">${fmtUsd(report.unmatched.gmv)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-normal text-muted-foreground">统计范围</CardTitle>
              </CardHeader>
              <CardContent className="text-sm tabular-nums">
                {report.period.start} ~ {report.period.end}
                {report.kpi_threshold > 0 ? (
                  <div className="text-xs text-muted-foreground mt-0.5">KPI 阈值：同事×站点 ≥ ${fmtUsd(report.kpi_threshold)}</div>
                ) : (
                  <div className="text-xs text-muted-foreground mt-0.5">全量口径：不做站点匹配与 KPI 阈值过滤</div>
                )}
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="md:col-span-3 col-span-2">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-normal text-muted-foreground">说明</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {report.period.start} ~ {report.period.end} · 仅在职同事
              {report.kpi_threshold > 0 ? ` · 单站点归因 GMV 低于 $${fmtUsd(report.kpi_threshold)} 不计入` : " · 全量展示，不做 KPI 阈值过滤"}
            </CardContent>
          </Card>
        )}
      </div>

      {mode === "admin" && report.non_usd.some((n) => n.usd_rate == null) ? (
        <div className="text-xs rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2">
          ⚠ 以下币种缺汇率，这些行<b>未计入</b>上面任何数字：
          {report.non_usd.filter((n) => n.usd_rate == null).map((n) => ` ${n.currency} ${fmtUsd(n.gmv)}（${n.rows} 行）`).join("；")}
          　请在「设置 → GMV 归因汇率」补齐后重新上传该批次。
        </div>
      ) : null}

      {mode === "admin" && report.non_usd.some((n) => n.usd_rate != null) ? (
        <div className="text-xs rounded-md border bg-muted/40 px-3 py-2">
          非美元币种折算明细（核对量级用）：
          {report.non_usd
            .filter((n) => n.usd_rate != null)
            .map((n) => ` ${n.currency} ${fmtUsd(n.gmv)} ÷ ${n.usd_rate} = $${fmtUsd(n.gmv_usd)}（${n.rows} 行）`)
            .join("；")}
        </div>
      ) : null}

      <StaffCountryTable title="BD" rows={bds} mode={mode} onDrill={onDrill} />
      <StaffCountryTable title="剪辑" rows={editors} mode={mode} onDrill={onDrill} />
      {!report.staff.length ? (
        <div className="text-sm text-muted-foreground text-center py-8">暂无归因数据（先同步达人登记，再生成报表）</div>
      ) : null}

      {mode === "admin" && report.unmatched.top.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              无建联达人（按 GMV 降序，共 {report.unmatched.top.length} 个，供补建联参考）
            </CardTitle>
          </CardHeader>
          <CardContent>
            {report.month ? (
              <UnmatchedTrendTable month={report.month} />
            ) : (
              <div className="border rounded-md overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>达人昵称</TableHead>
                      <TableHead className="text-right">当月 GMV</TableHead>
                      <TableHead className="text-right">行数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.unmatched.top.map((t) => (
                      <TableRow key={t.account_name}>
                        <TableCell className="text-xs">{t.account_name}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">${fmtUsd(t.gmv)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{t.rows}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

    </div>
  );
}
