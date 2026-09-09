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
                <div className="text-xs text-muted-foreground mt-0.5">KPI 阈值：同事×站点 ≥ ${fmtUsd(report.kpi_threshold)}</div>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="md:col-span-3 col-span-2">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-normal text-muted-foreground">说明</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {report.period.start} ~ {report.period.end} · 仅在职同事 · 单站点归因 GMV 低于 ${fmtUsd(report.kpi_threshold)} 不计入
            </CardContent>
          </Card>
        )}
      </div>

      {mode === "admin" && report.non_usd.length ? (
        <div className="text-xs rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
          ⚠ 存在非 USD 数据未计入：
          {report.non_usd.map((n) => ` ${n.currency} ${fmtUsd(n.gmv)}（${n.rows} 行）`).join("；")}
        </div>
      ) : null}

      {bds.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">BD（{bds.length}）</h3>
          <div className="grid gap-2 lg:grid-cols-2">
            {bds.map((s) => (
              <StaffRow key={`${s.staff_name}|${s.role}`} s={s} mode={mode} onDrill={onDrill} />
            ))}
          </div>
        </div>
      ) : null}
      {editors.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">剪辑（{editors.length}）</h3>
          <div className="grid gap-2 lg:grid-cols-2">
            {editors.map((s) => (
              <StaffRow key={`${s.staff_name}|${s.role}`} s={s} mode={mode} onDrill={onDrill} />
            ))}
          </div>
        </div>
      ) : null}
      {!report.staff.length ? (
        <div className="text-sm text-muted-foreground text-center py-8">暂无归因数据（先同步达人登记，再生成报表）</div>
      ) : null}

      {mode === "admin" && report.unmatched.top.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">无建联达人 TOP（按 GMV，供补建联参考）</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {report.unmatched.top.slice(0, 30).map((t) => (
                <span key={t.account_name} className="text-xs rounded px-1.5 py-0.5 border tabular-nums bg-muted/40">
                  {t.account_name} ${fmtUsd(t.gmv)}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
