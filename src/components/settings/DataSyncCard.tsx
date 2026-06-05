import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Database, RotateCw, Layers, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { DateRangeQuickSelect } from "@/components/DateRangeQuickSelect";

type SyncResp = {
  start_date: string;
  end_date: string;
  windows: number;
  advertisers: number;
  processed_advertisers: number;
  remaining_advertiser_ids: string[];
  upserted: number;
  batch_stats: Array<{
    advertiser_id: string;
    campaigns: number;
    campaigns_rank: number;
    group_batches: number;
    creative_calls: number;
    rows: number;
    rows_max_batch: number;
    saturated: boolean;
  }>;
  advertiser_names?: Record<string, string>;
  errors: Array<{ advertiser_id: string; window?: string; error: string }>;
  stopped_before_timeout?: { reason: string; remaining_advertiser_ids: string[] } | null;
};

type AdvStatus = "pending" | "running" | "success" | "failed";
type AdvRow = {
  advertiser_id: string;
  advertiser_name?: string;
  status: AdvStatus;
  rows?: number;
  campaigns?: number;
  days?: number;
  error?: string;
};

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000) + 1;

export function DataSyncCard() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [start, setStart] = React.useState(ago30);
  const [end, setEnd] = React.useState(today);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Map<string, AdvRow>>(new Map());
  const [progress, setProgress] = React.useState<{ iter: number; remaining: number; total: number } | null>(null);
  const [nameMap, setNameMap] = React.useState<Map<string, string>>(new Map());

  const mergeNames = (names?: Record<string, string>) => {
    if (!names) return;
    setNameMap((prev) => {
      const next = new Map(prev);
      for (const [k, v] of Object.entries(names)) if (v) next.set(k, v);
      return next;
    });
  };


  const nameOf = (id: string) => nameMap.get(id) ?? id;

  const updateRow = (id: string, patch: Partial<AdvRow>) => {
    setResults((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { advertiser_id: id, status: "pending" as AdvStatus };
      next.set(id, { ...cur, ...patch, advertiser_name: nameOf(id) });
      return next;
    });
  };

  // Run a sync loop until remaining is empty (max 10 iterations).
  const runLoop = async (label: string, s: string, e: string, initialIds?: string[]) => {
    setBusy(label);
    setResults(new Map());
    setProgress({ iter: 0, remaining: 0, total: 0 });
    const days = daysBetween(s, e);
    let queue = initialIds ? [...initialIds] : undefined; // undefined = first call syncs all
    let iter = 0;
    let totalUpserted = 0;
    let totalErrors = 0;
    try {
      while (iter < 10) {
        iter++;
        const reqBody: Record<string, unknown> = { start_date: s, end_date: e };
        if (queue && queue.length) {
          reqBody.advertiser_ids = queue;
          for (const id of queue) updateRow(id, { status: "running" });
        }
        const resp = await invokeFn<SyncResp>("gmv-max-sync", reqBody);
        mergeNames(resp.advertiser_names);
        totalUpserted += resp.upserted ?? 0;
        totalErrors += resp.errors?.length ?? 0;


        const processedThisRound = new Set<string>();
        for (const st of resp.batch_stats ?? []) {
          processedThisRound.add(st.advertiser_id);
          updateRow(st.advertiser_id, {
            status: "success",
            rows: st.rows,
            campaigns: st.campaigns,
            days,
          });
        }
        for (const err of resp.errors ?? []) {
          if (!processedThisRound.has(err.advertiser_id)) {
            updateRow(err.advertiser_id, { status: "failed", error: err.error });
          }
        }

        const remaining = resp.remaining_advertiser_ids ?? [];
        for (const id of remaining) {
          setResults((prev) => {
            const next = new Map(prev);
            if (!next.has(id)) next.set(id, { advertiser_id: id, advertiser_name: nameOf(id), status: "pending" });
            return next;
          });
        }
        setProgress({ iter, remaining: remaining.length, total: resp.advertisers });
        if (remaining.length === 0) break;
        if (queue && queue.length === remaining.length && queue.every((x) => remaining.includes(x))) {
          // No progress — abort to avoid infinite loop.
          for (const id of remaining) updateRow(id, { status: "failed", error: "续跑未推进，已停止" });
          break;
        }
        queue = remaining;
      }
      toast.success(`${label} 完成：${iter} 轮 / 写入 ${totalUpserted} 行${totalErrors ? ` / ${totalErrors} 错` : ""}`);
    } catch (e) {
      toast.error(`${label} 失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const retryOne = async (id: string) => {
    setBusy(`重跑 ${nameOf(id)}`);
    updateRow(id, { status: "running", error: undefined });
    try {
      const resp = await invokeFn<SyncResp>("gmv-max-sync", {
        start_date: start, end_date: end, advertiser_ids: [id],
      });
      const st = resp.batch_stats?.find((x) => x.advertiser_id === id);
      const err = resp.errors?.find((x) => x.advertiser_id === id);
      if (st) updateRow(id, { status: "success", rows: st.rows, campaigns: st.campaigns, days: daysBetween(start, end) });
      else if (err) updateRow(id, { status: "failed", error: err.error });
      else if (resp.remaining_advertiser_ids?.includes(id)) updateRow(id, { status: "failed", error: "单次时间预算不足，请重试" });
      toast.success(`重跑完成：写入 ${resp.upserted} 行`);
    } catch (e) {
      updateRow(id, { status: "failed", error: (e as Error).message });
      toast.error(`重跑失败：${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  const syncAllSheets = async () => {
    setBusy("同步飞书表");
    try {
      const [ed, bd, sku] = await Promise.all([
        invokeFn<Record<string, unknown>>("feishu-read-editors", {}).catch((e) => ({ error: (e as Error).message })),
        invokeFn<Record<string, unknown>>("feishu-read-bd-vids", {}).catch((e) => ({ error: (e as Error).message })),
        invokeFn<Record<string, unknown>>("feishu-read-sku", {}).catch((e) => ({ error: (e as Error).message })),
      ]);
      toast.success(`飞书表完成：editor=${JSON.stringify(ed).slice(0,80)} ...`);
      void bd; void sku;
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };

  const rows = Array.from(results.values()).sort((a, b) => {
    const order = { running: 0, pending: 1, failed: 2, success: 3 };
    return order[a.status] - order[b.status] || a.advertiser_id.localeCompare(b.advertiser_id);
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">数据同步</CardTitle>
        <p className="text-xs text-muted-foreground">
          飞书表数据全局共享；GMV Max 增量数据存于 Supabase。回溯会自动按账号续跑直到完成。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" disabled={!!busy} onClick={syncAllSheets}>
            <Layers className={`h-4 w-4 mr-1.5 ${busy === "同步飞书表" ? "animate-spin" : ""}`} />
            同步飞书表（剪辑+BD+SKU）
          </Button>
        </div>
        <div className="border-t pt-3 space-y-3">
          <div className="text-xs text-muted-foreground">GMV Max 回溯（点一次自动排队跑所有账号，失败可单独重跑）</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">起始</span>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">结束</span>
              <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 w-40" />
            </div>
            <DateRangeQuickSelect onPick={(s, e) => { setStart(s); setEnd(e); }} />
            <Button size="sm" disabled={!!busy} onClick={() => runLoop("GMV Max 回溯", start, end)}>
              <Database className={`h-4 w-4 mr-1.5 ${busy === "GMV Max 回溯" ? "animate-spin" : ""}`} />
              开始回溯
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => {
              const e2 = today;
              const s2 = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
              runLoop("最近3天", s2, e2);
            }}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${busy === "最近3天" ? "animate-spin" : ""}`} />
              最近3天
            </Button>
          </div>

          {progress && (
            <div className="text-xs text-muted-foreground">
              进度：第 {progress.iter} 轮 · 剩余 {progress.remaining} / {progress.total} 个账号
            </div>
          )}

          {rows.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8">广告户</TableHead>
                    <TableHead className="h-8">状态</TableHead>
                    <TableHead className="h-8 text-right">天数</TableHead>
                    <TableHead className="h-8 text-right">行数</TableHead>
                    <TableHead className="h-8 text-right">广告</TableHead>
                    <TableHead className="h-8">错误</TableHead>
                    <TableHead className="h-8 w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.advertiser_id}>
                      <TableCell className="py-1.5">
                        <div className="font-medium">{r.advertiser_name ?? nameOf(r.advertiser_id)}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">{r.advertiser_id}</div>
                      </TableCell>
                      <TableCell className="py-1.5">
                        {r.status === "success" && <span className="inline-flex items-center gap-1 text-green-600 text-xs"><CheckCircle2 className="h-3.5 w-3.5" />成功</span>}
                        {r.status === "failed" && <span className="inline-flex items-center gap-1 text-red-600 text-xs"><XCircle className="h-3.5 w-3.5" />失败</span>}
                        {r.status === "pending" && <span className="inline-flex items-center gap-1 text-amber-600 text-xs"><Clock className="h-3.5 w-3.5" />排队</span>}
                        {r.status === "running" && <span className="inline-flex items-center gap-1 text-blue-600 text-xs"><Loader2 className="h-3.5 w-3.5 animate-spin" />运行中</span>}
                      </TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">{r.days ?? "—"}</TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">{r.rows ?? "—"}</TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">{r.campaigns ?? "—"}</TableCell>
                      <TableCell className="py-1.5 text-xs text-red-600 max-w-[260px] truncate" title={r.error}>{r.error ?? ""}</TableCell>
                      <TableCell className="py-1.5">
                        {(r.status === "failed" || r.status === "pending") && (
                          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={!!busy} onClick={() => retryOne(r.advertiser_id)}>
                            重跑
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
