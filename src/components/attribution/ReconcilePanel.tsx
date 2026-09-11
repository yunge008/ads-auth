// 金额对账：归并层（上传进来多少钱）vs 快照层（归因算出多少钱）并排看。
// 两边合计不相等 = 中间丢了；差在哪个内容类型、被扔进哪个桶，一眼可见。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Scale } from "lucide-react";
import { toast } from "sonner";
import { type ReconcileResult, fmtUsd, reconcileAttribution } from "@/lib/attributionApi";

const TYPE_LABELS: Record<string, string> = {
  video: "视频",
  live: "直播",
  product_card: "商品卡",
  other: "其他",
};
const BUCKET_LABELS: Record<string, string> = {
  STAFF: "已归人",
  PRODUCT_CARD: "商品卡桶",
  OTHER: "其他桶",
  UNMATCHED: "无建联",
};
const label = (t: string) => TYPE_LABELS[t] ?? t ?? "（空）";
const n = (v: number) => Math.round(v).toLocaleString();

export function ReconcilePanel({ month }: { month: string }) {
  const [data, setData] = React.useState<ReconcileResult | null>(null);
  const [loading, setLoading] = React.useState(false);

  const run = async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    try {
      setData(await reconcileAttribution(month));
    } catch (e) {
      toast.error(`对账失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };
  React.useEffect(() => { setData(null); }, [month]);

  const agg = (data?.rows ?? []).filter((r) => r.scope === "AGG");
  const snap = (data?.rows ?? []).filter((r) => r.scope === "RUN");
  const aggTotal = agg.reduce((x, r) => x + r.gmv_usd, 0);
  const snapTotal = snap.reduce((x, r) => x + r.gmv_usd, 0);
  const uploadRows = (data?.uploads ?? []).reduce((x, u) => x + (u.row_count ?? 0), 0);
  const aggRows = agg.reduce((x, r) => x + r.rows, 0);
  const noRate = agg.reduce((x, r) => x + r.no_rate_rows, 0);
  const diff = aggTotal - snapTotal;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">金额对账</CardTitle>
          <Button size="sm" variant="outline" onClick={run} disabled={loading}>
            <Scale className={`h-4 w-4 mr-1.5 ${loading ? "animate-pulse" : ""}`} />
            {loading ? "对账中…" : `对账 ${month}`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          归并层 = 上传进来的钱（ad_upload_agg），快照层 = 归因算出的钱（本月最新快照）。
          两边合计应该相等；不等就是中间丢了，看是哪个内容类型对不上。
        </p>
      </CardHeader>
      {data ? (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="rounded-md border px-2 py-1.5">
              <div className="text-muted-foreground">上传原始行 / 归并行</div>
              <div className="text-base font-semibold tabular-nums">{n(uploadRows)} / {n(aggRows)}</div>
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <div className="text-muted-foreground">归并层 GMV</div>
              <div className="text-base font-semibold tabular-nums">${fmtUsd(aggTotal)}</div>
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <div className="text-muted-foreground">快照层 GMV</div>
              <div className="text-base font-semibold tabular-nums">${fmtUsd(snapTotal)}</div>
            </div>
            <div className={`rounded-md border px-2 py-1.5 ${Math.abs(diff) > 1 ? "border-destructive" : ""}`}>
              <div className="text-muted-foreground">差额</div>
              <div className={`text-base font-semibold tabular-nums ${Math.abs(diff) > 1 ? "text-destructive" : ""}`}>
                ${fmtUsd(diff)}
              </div>
            </div>
          </div>

          {!data.run ? (
            <div className="text-sm rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
              该月还没有归因快照，快照层为空。先点「重新计算」。
            </div>
          ) : null}
          {noRate ? (
            <div className="text-sm rounded-md border border-destructive/60 px-3 py-2">
              归并层有 {n(noRate)} 组缺汇率（usd_rate 为空），这部分金额折不出美元、不计入任何汇总。
              去「设置 → GMV 归因汇率」补齐后再点「重新计算」。
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>归并层 · 内容类型</TableHead>
                    <TableHead className="text-right">原始行</TableHead>
                    <TableHead className="text-right">GMV（USD）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agg.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="h-12 text-center text-xs text-muted-foreground">无数据</TableCell></TableRow>
                  ) : agg.map((r) => (
                    <TableRow key={r.creative_type}>
                      <TableCell className="text-xs">{label(r.creative_type)}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{n(r.rows)}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">${fmtUsd(r.gmv_usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>快照层 · 类型 × 桶</TableHead>
                    <TableHead className="text-right">原始行</TableHead>
                    <TableHead className="text-right">GMV（USD）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="h-12 text-center text-xs text-muted-foreground">无快照数据</TableCell></TableRow>
                  ) : snap
                    .slice()
                    .sort((a, b) => b.gmv_usd - a.gmv_usd)
                    .map((r) => (
                      <TableRow key={`${r.creative_type}|${r.bucket}`}>
                        <TableCell className="text-xs">
                          {label(r.creative_type)} · {BUCKET_LABELS[r.bucket] ?? r.bucket}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{n(r.rows)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">${fmtUsd(r.gmv_usd)}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>批次</TableHead>
                  <TableHead>站点</TableHead>
                  <TableHead className="text-right">原始行数</TableHead>
                  <TableHead className="text-right">批次记录的 GMV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.uploads.map((u, i) => (
                  <TableRow key={`${u.file_name}-${i}`}>
                    <TableCell className="text-xs max-w-56 truncate" title={u.file_name}>{u.file_name}</TableCell>
                    <TableCell className="text-xs">{u.country}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{n(u.row_count ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">${fmtUsd(u.total_revenue ?? 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
