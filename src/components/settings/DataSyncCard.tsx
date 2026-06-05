import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Database, RotateCw, Layers } from "lucide-react";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { DateRangeQuickSelect } from "@/components/DateRangeQuickSelect";

export function DataSyncCard() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [start, setStart] = React.useState(ago30);
  const [end, setEnd] = React.useState(today);
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const r = (await work()) as Record<string, unknown>;
      const summary = Object.entries(r)
        .filter(([k]) => k !== "errors")
        .map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`)
        .join(" / ");
      toast.success(`${label} 完成：${summary}`);
      const errs = (r as { errors?: { error: string }[] }).errors;
      if (errs?.length) toast.warning(`${errs.length} 条错误：${errs[0].error}`);
    } catch (e) {
      toast.error(`${label} 失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const syncAllSheets = async () => {
    await run("同步飞书表（剪辑+BD+SKU）", async () => {
      const [ed, bd, sku] = await Promise.all([
        invokeFn<Record<string, unknown>>("feishu-read-editors", {}).catch((e) => ({ error: (e as Error).message })),
        invokeFn<Record<string, unknown>>("feishu-read-bd-vids", {}).catch((e) => ({ error: (e as Error).message })),
        invokeFn<Record<string, unknown>>("feishu-read-sku", {}).catch((e) => ({ error: (e as Error).message })),
      ]);
      return { editor: ed, bd, sku };
    });
  };

  const backfill = () =>
    run("GMV Max 回溯", () =>
      invokeFn<Record<string, unknown>>("gmv-max-sync", { start_date: start, end_date: end }),
    );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">数据同步</CardTitle>
        <p className="text-xs text-muted-foreground">
          飞书表数据为全局共享，所有用户共用一份；GMV Max 增量数据存于 Supabase，按日期回溯即可。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" disabled={!!busy} onClick={syncAllSheets}>
            <Layers className={`h-4 w-4 mr-1.5 ${busy?.startsWith("同步飞书表") ? "animate-spin" : ""}`} />
            同步飞书表（剪辑+BD+SKU）
          </Button>
        </div>
        <div className="border-t pt-3">
          <div className="text-xs text-muted-foreground mb-2">GMV Max 回溯（超过 30 天自动按窗口拆分）</div>
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
            <Button size="sm" disabled={!!busy} onClick={backfill}>
              <Database className={`h-4 w-4 mr-1.5 ${busy === "GMV Max 回溯" ? "animate-spin" : ""}`} />
              开始回溯
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => {
              const e2 = today;
              const s2 = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
              run("拉取最近3天", () => invokeFn<Record<string, unknown>>("gmv-max-sync", { start_date: s2, end_date: e2 }));
            }}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${busy === "拉取最近3天" ? "animate-spin" : ""}`} />
              最近3天
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
