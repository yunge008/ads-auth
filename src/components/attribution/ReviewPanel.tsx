// 审查面板：查看审查项 + 与飞书「归因审查」表的往返（回写新项 / 读回人工判定）。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RotateCw, Upload, Download, BookUser } from "lucide-react";
import { toast } from "sonner";
import { type ReviewRec, REVIEW_TYPE_LABELS, feishuAction } from "@/lib/attributionApi";

export function ReviewPanel() {
  const [reviews, setReviews] = React.useState<ReviewRec[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await feishuAction<{ reviews: ReviewRec[] }>("list-reviews");
      setReviews(r.reviews ?? []);
    } catch (e) {
      toast.error(`加载审查项失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const run = async (action: string, label: string) => {
    setBusy(action);
    try {
      const r = await feishuAction<Record<string, unknown>>(action);
      const warnings = (r.warnings as string[] | undefined) ?? [];
      toast.success(`${label}完成：${JSON.stringify({ ...r, warnings: undefined })}`);
      for (const w of warnings) toast.warning(w);
      await load();
    } catch (e) {
      toast.error(`${label}失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const open = reviews.filter((r) => r.status === "OPEN");

  return (
    <Card>
      <CardHeader className="pb-3 space-y-2">
        <CardTitle className="text-base">
          归因审查 <span className="text-xs font-normal text-muted-foreground ml-1">待处理 {open.length} / 共 {reviews.length}</span>
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
          <Button size="sm" onClick={() => run("write-reviews", "回写审查表")} disabled={!!busy}>
            <Upload className="h-4 w-4 mr-1.5" />回写新审查项到飞书
          </Button>
          <Button size="sm" onClick={() => run("read-judgments", "读回人工判定")} disabled={!!busy}>
            <Download className="h-4 w-4 mr-1.5" />读回人工判定
          </Button>
          <Button size="sm" variant="outline" onClick={() => run("write-ownership", "更新达人归因表")} disabled={!!busy}>
            <BookUser className="h-4 w-4 mr-1.5" />更新飞书「达人归因表」
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          流程：回写新审查项 → 在飞书「归因审查」表 J 列填人工判定 BD（填「忽略」表示仅关闭）、K 列备注 → 读回人工判定。人工判定优先级最高且不会被自动覆盖。
        </p>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>主体</TableHead>
                <TableHead>默认处理</TableHead>
                <TableHead>人工判定</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近发现</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6} className="h-16 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
              ) : reviews.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-16 text-center text-sm text-muted-foreground">暂无审查项</TableCell></TableRow>
              ) : reviews.map((r) => (
                <TableRow key={r.review_key}>
                  <TableCell className="text-xs whitespace-nowrap">{REVIEW_TYPE_LABELS[r.review_type] ?? r.review_type}</TableCell>
                  <TableCell className="text-xs max-w-56 truncate" title={r.review_key}>{r.subject}</TableCell>
                  <TableCell className="text-xs max-w-72 truncate" title={r.default_resolution ?? ""}>{r.default_resolution || "—"}</TableCell>
                  <TableCell className="text-xs">{r.manual_bd || "—"}{r.manual_note ? `（${r.manual_note}）` : ""}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "OPEN" ? "destructive" : "secondary"}>{r.status === "OPEN" ? "待处理" : "已裁决"}</Badge>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">{(r.last_seen_at ?? "").slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
