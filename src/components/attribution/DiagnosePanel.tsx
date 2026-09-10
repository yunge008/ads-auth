// 归因口径自查面板：把归因瀑布每一层的命中量摊开，直接指出「一个人都归不上」断在哪一层。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { diagnoseAttribution, type DiagnoseResult } from "@/lib/attributionApi";

const n = (v: number) => v.toLocaleString();

export function DiagnosePanel({ month }: { month: string }) {
  const [loading, setLoading] = React.useState(false);
  const [data, setData] = React.useState<DiagnoseResult | null>(null);

  const run = async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      toast.error("请先选择月份");
      return;
    }
    setLoading(true);
    try {
      setData(await diagnoseAttribution(month));
    } catch (e) {
      toast.error(`自查失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">归因口径自查</CardTitle>
          <Button size="sm" variant="outline" onClick={run} disabled={loading}>
            <Stethoscope className={`h-4 w-4 mr-1.5 ${loading ? "animate-pulse" : ""}`} />
            {loading ? "扫描中…" : `自查 ${month}`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          按归因瀑布逐层统计：商品卡 → VID 强匹配 → 昵称（站点必须一致）→ 无建联。哪一层命中为 0，问题就在哪一层。
        </p>
      </CardHeader>
      {data ? (
        <CardContent className="space-y-4">
          <div className="space-y-1">
            {data.hints.map((h, i) => (
              <div key={i} className="text-sm rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
                {h}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
            {[
              ["登记 VID 数", data.context.vid_count],
              ["建联归属键", data.context.ownership_keys],
              ["人工别名", data.context.manual_alias],
              ["VID 推断别名", data.context.vid_alias],
              ["交接站点数", data.context.handover_countries],
              ["人工判定数", data.context.review_overrides],
            ].map(([label, v]) => (
              <div key={label as string} className="rounded-md border px-2 py-1.5">
                <div className="text-muted-foreground">{label}</div>
                <div className="text-base font-semibold tabular-nums">{n(v as number)}</div>
              </div>
            ))}
          </div>

          <div className="text-xs space-y-1">
            <div>
              <span className="text-muted-foreground mr-2">上传站点写法</span>
              {data.upload_countries.map((c) => <Badge key={c} variant="secondary" className="mr-1">{c}</Badge>)}
            </div>
            <div>
              <span className="text-muted-foreground mr-2">建联表站点写法</span>
              {data.registry_countries.slice(0, 20).map((c) => (
                <Badge key={c.country} variant="outline" className="mr-1">{c.country}（{n(c.keys)}）</Badge>
              ))}
              {data.registry_countries.length === 0 ? <span className="text-destructive">（空）</span> : null}
            </div>
            <div className="text-muted-foreground">
              两边写法必须逐字一致（大小写/空格自动归一，中英文不会）；对不上的行一律进「无建联」桶。
            </div>
          </div>

          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>批次</TableHead>
                  <TableHead>站点</TableHead>
                  <TableHead className="text-right">扫描行数</TableHead>
                  <TableHead className="text-right">商品卡</TableHead>
                  <TableHead className="text-right">带VID行 / VID命中</TableHead>
                  <TableHead className="text-right">昵称·同站点命中</TableHead>
                  <TableHead className="text-right">昵称·登记在别站点</TableHead>
                  <TableHead className="text-right">从未登记</TableHead>
                  <TableHead className="text-right">无账号名</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.uploads.map((u, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs max-w-56 truncate" title={u.file_name}>
                      {u.file_name}
                      {u.sampled ? <Badge variant="secondary" className="ml-1">抽样</Badge> : null}
                    </TableCell>
                    <TableCell className="text-xs">{u.country}</TableCell>
                    <TableCell className="text-right tabular-nums">{n(u.rows)}</TableCell>
                    <TableCell className="text-right tabular-nums">{n(u.product_card)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {n(u.vid_rows)} / <span className={u.vid_hit ? "" : "text-destructive"}>{n(u.vid_hit)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={u.name_hit_same_site ? "" : "text-destructive"}>{n(u.name_hit_same_site)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{n(u.name_hit_other_site)}</TableCell>
                    <TableCell className="text-right tabular-nums">{n(u.name_never_registered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{n(u.no_name)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-medium">
                  <TableCell colSpan={2}>合计</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.rows)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.product_card)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.vid_rows)} / {n(data.totals.vid_hit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.name_hit_same_site)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.name_hit_other_site)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.name_never_registered)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(data.totals.no_name)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {data.totals.name_hit_other_site > 0 ? (
            <div className="text-xs space-y-1">
              <div className="font-medium">「名字在、站点对不上」的样本</div>
              {data.uploads.flatMap((u) =>
                u.other_site_samples.map((s, i) => (
                  <div key={`${u.file_name}-${i}`} className="text-muted-foreground">
                    上传站点 <b>{u.country}</b> 的「{s.account_name}」→ 登记在 {s.registered_sites.join("、")}
                  </div>
                )),
              ).slice(0, 20)}
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
