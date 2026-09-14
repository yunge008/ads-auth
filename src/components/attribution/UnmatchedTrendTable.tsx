// 无建联达人 12 个月趋势表：站点/国家 + 达人名称 + 近 12 个月 GMV（新→旧）。
// 默认按**当月**（也就是所选月份）GMV 降序——补建联要先看这个月谁在花钱，
// 按 12 个月合计排序会把早就不投的老达人顶到前面。20 行一页。
import * as React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { type UnmatchedTrendRow, fmtUsd, unmatchedTrend } from "@/lib/attributionApi";

export function UnmatchedTrendTable({ month }: { month: string }) {
  const [months, setMonths] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<UnmatchedTrendRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [country, setCountry] = React.useState("__all__");
  const [page, setPage] = React.useState(1);

  const load = React.useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    try {
      const r = await unmatchedTrend(month);
      setMonths(r.months);
      setRows(r.rows);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [month]);
  React.useEffect(() => { load(); }, [load]);

  const countries = React.useMemo(() => Array.from(new Set(rows.map((r) => r.country))).sort(), [rows]);
  /** 当月 GMV 降序；当月都是 0 的用 12 个月合计兜底排序，免得顺序看起来是随机的 */
  const filtered = React.useMemo(() => {
    const list = country === "__all__" ? rows : rows.filter((r) => r.country === country);
    return [...list].sort(
      (a, b) => (b.by_month[month] ?? 0) - (a.by_month[month] ?? 0) || b.total - a.total,
    );
  }, [rows, country, month]);

  const PAGE_SIZE = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageRows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  React.useEffect(() => { setPage(1); }, [country, month, rows]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select value={country} onValueChange={setCountry}>
          <SelectTrigger className="h-8 w-40"><SelectValue placeholder="全部站点" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部站点</SelectItem>
            {countries.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          共 {filtered.length} 个达人 · 按 {month} GMV 降序
        </span>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground text-center py-10"><RotateCw className="h-4 w-4 animate-spin inline mr-1.5" />加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-10">暂无数据</div>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background whitespace-nowrap">站点</TableHead>
                <TableHead className="sticky left-14 bg-background whitespace-nowrap">达人昵称</TableHead>
                <TableHead className="text-right whitespace-nowrap">当月 GMV</TableHead>
                {months.map((m) => <TableHead key={m} className="text-right whitespace-nowrap">{m}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((r) => (
                <TableRow key={`${r.country}|${r.account_name}`}>
                  <TableCell className="sticky left-0 bg-background text-xs">{r.country}</TableCell>
                  <TableCell className="sticky left-14 bg-background text-xs max-w-40 truncate" title={r.account_name}>{r.account_name}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs font-semibold">
                    {r.by_month[month] == null ? "—" : `$${fmtUsd(r.by_month[month])}`}
                  </TableCell>
                  {months.map((m) => (
                    <TableCell key={m} className="text-right tabular-nums text-xs">
                      {r.by_month[m] == null ? "—" : `$${fmtUsd(r.by_month[m])}`}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!loading && pageCount > 1 ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            第 {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, filtered.length)} 条 · 共 {pageCount} 页
          </span>
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={current >= pageCount} onClick={() => setPage(current + 1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
