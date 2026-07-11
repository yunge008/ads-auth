// 归因明细下钻表（服务端已按 GMV 降序，前端只做分页）。
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type DetailRow, MATCH_LABELS, fmtUsd2 } from "@/lib/attributionApi";

const PAGE_SIZE = 20;

const TYPE_LABELS: Record<string, string> = { video: "视频", product_card: "商品卡", live: "直播", unknown: "—" };

export function DetailTable({ rows, loading, title }: { rows: DetailRow[]; loading?: boolean; title?: string }) {
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const paged = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-2">
      {title ? <div className="text-sm font-medium">{title}<span className="text-xs text-muted-foreground ml-2">共 {rows.length} 行（上限 5000）</span></div> : null}
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>VID</TableHead>
              <TableHead>账号昵称</TableHead>
              <TableHead>站点</TableHead>
              <TableHead>类型</TableHead>
              <TableHead className="text-right">GMV</TableHead>
              <TableHead className="text-right">消耗</TableHead>
              <TableHead className="text-right">订单</TableHead>
              <TableHead>归因</TableHead>
              <TableHead>发布时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={9} className="h-16 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
            ) : paged.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="h-16 text-center text-sm text-muted-foreground">暂无数据</TableCell></TableRow>
            ) : paged.map((r, i) => (
              <TableRow key={`${r.vid}-${r.account_name}-${i}`}>
                <TableCell className="font-mono text-xs">{r.vid || "—"}</TableCell>
                <TableCell className="text-xs max-w-48 truncate" title={r.account_name}>{r.account_name || "—"}</TableCell>
                <TableCell className="text-xs">{r.country || "未知站点"}</TableCell>
                <TableCell className="text-xs">{TYPE_LABELS[r.creative_type] ?? r.creative_type}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsd2(r.gmv)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsd2(r.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
                <TableCell className="text-xs">
                  {r.bucket === "STAFF"
                    ? `${r.staff}（${r.match_type ? MATCH_LABELS[r.match_type] ?? r.match_type : "—"}${r.handover_applied ? "·交接" : ""}）`
                    : r.bucket === "PRODUCT_CARD" ? "商品卡" : "无建联"}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {r.posted_at ? r.posted_at.slice(0, 10) : "—"}
                  {r.posted_at_source === "vid" ? <span className="text-muted-foreground" title="由 VID 推算，±2 天误差">*</span> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
          <span>{page} / {pageCount}</span>
          <Button size="sm" variant="outline" className="h-7" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
        </div>
      )}
    </div>
  );
}
