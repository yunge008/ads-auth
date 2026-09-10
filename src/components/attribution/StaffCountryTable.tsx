// 同事 × 站点 归因表：每个国家一列，数据落在对应单元格；无数据显示「—」，0 显示 0。
// counted=false 只有在 KPI 阈值启用时才可能出现（阈值为 0 时全部计入，不再置灰）。
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type DrillFilter, type StaffAgg, fmtPct, fmtUsd } from "@/lib/attributionApi";

export function StaffCountryTable({
  title,
  rows,
  mode,
  onDrill,
}: {
  title: string;
  rows: StaffAgg[];
  mode: "admin" | "user";
  onDrill?: (f: DrillFilter) => void;
}) {
  const countries = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of rows) for (const c of s.by_country) totals.set(c.country, (totals.get(c.country) ?? 0) + c.gmv);
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([c]) => c);
  }, [rows]);

  if (!rows.length) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}（{rows.length}）</h3>
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background whitespace-nowrap">姓名</TableHead>
              <TableHead className="whitespace-nowrap">角色</TableHead>
              <TableHead className="whitespace-nowrap">状态</TableHead>
              <TableHead className="text-right whitespace-nowrap">合计 GMV</TableHead>
              <TableHead className="text-right whitespace-nowrap">VID / 达人</TableHead>
              {mode === "admin" ? (
                <>
                  <TableHead className="text-right whitespace-nowrap">目标</TableHead>
                  <TableHead className="text-right whitespace-nowrap">进度</TableHead>
                </>
              ) : null}
              {countries.map((c) => (
                <TableHead key={c} className="text-right whitespace-nowrap">{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => {
              const byCountry = new Map(s.by_country.map((c) => [c.country, c]));
              return (
                <TableRow key={`${s.staff_name}|${s.role}`}>
                  <TableCell className="sticky left-0 bg-background font-medium whitespace-nowrap">
                    <button
                      type="button"
                      className={onDrill ? "hover:underline" : "cursor-default"}
                      onClick={() => onDrill?.({ staff: s.staff_name, role: s.role })}
                    >
                      {s.staff_name}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.role === "BD" ? "default" : "secondary"}>{s.role === "BD" ? "BD" : "剪辑"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.active ? "在职" : "已离职"}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">${fmtUsd(s.gmv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs whitespace-nowrap">
                    {s.vids ?? 0} / {s.creators ?? 0}
                  </TableCell>
                  {mode === "admin" ? (
                    <>
                      <TableCell className="text-right tabular-nums text-xs">
                        {s.target_usd ? `$${fmtUsd(s.target_usd)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {s.progress != null ? fmtPct(s.progress) : "—"}
                      </TableCell>
                    </>
                  ) : null}
                  {countries.map((c) => {
                    const cell = byCountry.get(c);
                    return (
                      <TableCell
                        key={c}
                        className={`text-right tabular-nums text-xs ${cell && !cell.counted ? "opacity-50" : ""}`}
                        title={cell && !cell.counted ? "低于 KPI 阈值，不计入进度" : undefined}
                      >
                        {cell ? (
                          <>
                            <div>${fmtUsd(cell.gmv)}</div>
                            {/* 归因口径：和 GMV 并列展示去重后的 VID 数 / 达人数 */}
                            <div className="text-[11px] text-muted-foreground">
                              {cell.vids ?? 0} VID / {cell.creators ?? 0} 达人
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
