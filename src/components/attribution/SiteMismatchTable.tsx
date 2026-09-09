// 站点未匹配确认表：站点按字母精确匹配后仍归「无建联」，但达人名字在建联归属/别名表里登记过
// （只是登记在别的站点）的行。归因不会自动跨站点认人，这里列出来供人工确认。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, RotateCw } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { type SiteMismatchRow, fmtUsd, siteMismatch } from "@/lib/attributionApi";

const HEADER = ["上传站点", "达人昵称", "行数", "GMV(USD)", "登记站点", "登记归属BD", "登记来源"];

export function SiteMismatchTable({ month }: { month: string }) {
  const [rows, setRows] = React.useState<SiteMismatchRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    try {
      const r = await siteMismatch(month);
      setRows(r.rows);
    } catch (e) {
      setRows(null);
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [month]);

  const exportXlsx = () => {
    if (!rows?.length) return;
    const aoa = [
      HEADER,
      ...rows.map((r) => [
        r.upload_country,
        r.account_name,
        r.rows,
        r.gmv_usd,
        r.registered.map((o) => o.country).join(" / "),
        r.registered.map((o) => o.bd).join(" / "),
        r.registered.map((o) => o.source).join(" / "),
      ]),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "站点未匹配");
    XLSX.writeFile(wb, `站点未匹配-${month}.xlsx`);
  };

  const totalGmv = (rows ?? []).reduce((a, r) => a + r.gmv_usd, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm">站点未匹配确认（{month}）</CardTitle>
          <Button size="sm" variant="outline" className="h-7" onClick={load} disabled={loading}>
            <RotateCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />查询
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={exportXlsx} disabled={!rows?.length}>
            <Download className="h-3.5 w-3.5 mr-1.5" />导出
          </Button>
          {rows ? (
            <span className="text-xs text-muted-foreground">
              共 {rows.length} 个达人 · 合计 ${fmtUsd(totalGmv)}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          站点按字母精确匹配，名字对得上但站点对不上的行一律归「无建联」，不自动改判。
          下表列出这类行：达人名字在建联归属表/别名表里登记过，但登记站点与上传站点不同。
          确认后可在「审查与回写」里人工判定，或去飞书建联表把站点改对再重新同步达人登记。
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-10">
            <RotateCw className="h-4 w-4 animate-spin inline mr-1.5" />扫描中…
          </div>
        ) : rows == null ? (
          <div className="text-sm text-muted-foreground text-center py-10">点「查询」扫描该月数据</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-10">
            没有这类行 —— 该月「无建联」的达人名字在建联表里都查不到，属于真的没建联
          </div>
        ) : (
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">上传站点</TableHead>
                  <TableHead className="whitespace-nowrap">达人昵称</TableHead>
                  <TableHead className="text-right whitespace-nowrap">行数</TableHead>
                  <TableHead className="text-right whitespace-nowrap">GMV(USD)</TableHead>
                  <TableHead className="whitespace-nowrap">登记在（站点 · BD · 来源）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.upload_country}|${r.account_name}`}>
                    <TableCell className="text-xs"><Badge variant="outline">{r.upload_country}</Badge></TableCell>
                    <TableCell className="text-xs max-w-56 truncate" title={r.account_name}>{r.account_name}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{r.rows}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs font-semibold">${fmtUsd(r.gmv_usd)}</TableCell>
                    <TableCell className="text-xs">
                      {r.registered.map((o, i) => (
                        <div key={i} className="whitespace-nowrap">
                          <Badge variant="secondary" className="mr-1">{o.country || "（空站点）"}</Badge>
                          {o.bd}
                          <span className="text-muted-foreground ml-1">· {o.source}</span>
                        </div>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
