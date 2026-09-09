// 无建联达人 12 个月趋势表：站点/国家 + 达人名称 + 近 12 个月 GMV（新→旧），可按站点筛选，按合计 GMV 降序。
import * as React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { type UnmatchedTrendRow, fmtUsd, unmatchedTrend } from "@/lib/attributionApi";

export function UnmatchedTrendTable({ month }: { month: string }) {
  const [months, setMonths] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<UnmatchedTrendRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [country, setCountry] = React.useState("__all__");

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
  const filtered = country === "__all__" ? rows : rows.filter((r) => r.country === country);

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
        <span className="text-xs text-muted-foreground">共 {filtered.length} 个达人 · 按合计 GMV 降序</span>
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
                <TableHead className="sticky left-0 bg-background">站点</TableHead>
                <TableHead className="sticky left-14 bg-background">达人名称</TableHead>
                {months.map((m) => <TableHead key={m} className="text-right whitespace-nowrap">{m}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={`${r.country}|${r.account_name}`}>
                  <TableCell className="sticky left-0 bg-background text-xs">{r.country}</TableCell>
                  <TableCell className="sticky left-14 bg-background text-xs max-w-40 truncate" title={r.account_name}>{r.account_name}</TableCell>
                  {months.map((m) => (
                    <TableCell key={m} className="text-right tabular-nums text-xs">
                      {r.by_month[m] ? `$${fmtUsd(r.by_month[m])}` : "—"}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
