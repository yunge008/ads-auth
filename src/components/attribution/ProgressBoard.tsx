// 归因进度板：每人 GMV vs 目标进度条 + 站点明细 + （管理视图）商品卡/无建联桶与口径拆分。
import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  type AttributionReport,
  type DrillFilter,
  type StaffAgg,
  MATCH_LABELS,
  fmtPct,
  fmtUsd,
} from "@/lib/attributionApi";

function StaffRow({
  s,
  mode,
  onDrill,
}: {
  s: StaffAgg;
  mode: "admin" | "user";
  onDrill?: (f: DrillFilter) => void;
}) {
  const pct = s.progress != null ? Math.min(100, Math.round(s.progress * 100)) : null;
  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`font-medium ${onDrill ? "hover:underline" : "cursor-default"}`}
            onClick={() => onDrill?.({ staff: s.staff_name, role: s.role })}
          >
            {s.staff_name}
          </button>
          <Badge variant={s.role === "BD" ? "default" : "secondary"}>{s.role === "BD" ? "BD" : "剪辑"}</Badge>
          {mode === "admin" && !s.active ? <Badge variant="outline">已离职</Badge> : null}
        </div>
        <div className="text-sm tabular-nums">
          <span className="font-semibold">${fmtUsd(mode === "user" ? s.gmv : s.counted_gmv)}</span>
          {s.target_usd ? <span className="text-muted-foreground"> / 目标 ${fmtUsd(s.target_usd)}</span> : null}
          {s.progress != null ? <span className="ml-2 text-muted-foreground">{fmtPct(s.progress)}</span> : null}
          {mode === "admin" && s.gmv !== s.counted_gmv ? (
            <span className="ml-2 text-xs text-muted-foreground">（全量 ${fmtUsd(s.gmv)}）</span>
          ) : null}
        </div>
      </div>
      {pct != null ? <Progress value={pct} /> : null}
      <div className="flex flex-wrap gap-1.5">
        {s.by_country.map((c) => (
          <span
            key={c.country}
            title={c.counted ? undefined : "低于 KPI 阈值，不计入进度"}
            className={`text-xs rounded px-1.5 py-0.5 border tabular-nums ${
              c.counted ? "bg-muted/60" : "opacity-50 line-through"
            }`}
          >
            {c.country} ${fmtUsd(c.gmv)}
          </span>
        ))}
      </div>
      {mode === "admin" ? (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground tabular-nums">
          {(Object.keys(MATCH_LABELS) as Array<keyof typeof MATCH_LABELS>)
            .filter((k) => (s.by_match[k] ?? 0) > 0)
            .map((k) => (
              <span key={k}>
                {MATCH_LABELS[k]} ${fmtUsd(s.by_match[k] ?? 0)}
              </span>
            ))}
        </div>
      ) : null}
    </div>
  );
}

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
