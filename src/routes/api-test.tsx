import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Play, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { invokeFn } from "@/lib/api";
import { toast } from "sonner";

export const Route = createFileRoute("/api-test")({
  head: () => ({ meta: [{ title: "API测试 - TikTok授权工具" }] }),
  component: ApiTestPage,
});

const sample = `gmv-max-sync {"mode":"incremental"}`;

function parseCommand(input: string): { name: string; body: Record<string, unknown> } {
  const raw = input.trim();
  if (!raw) throw new Error("请输入查询指令");
  if (raw.startsWith("{")) {
    const json = JSON.parse(raw) as { function?: string; name?: string; body?: Record<string, unknown> };
    const name = (json.function ?? json.name ?? "").trim();
    if (!name) throw new Error("JSON 中需要 function 或 name 字段");
    return { name, body: json.body ?? {} };
  }
  const firstSpace = raw.search(/\s/);
  const name = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const bodyText = firstSpace === -1 ? "{}" : raw.slice(firstSpace).trim();
  return { name, body: bodyText ? JSON.parse(bodyText) : {} };
}

function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ApiTestPage() {
  const [command, setCommand] = React.useState(sample);
  const [output, setOutput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [advertiserId, setAdvertiserId] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");

  const run = async () => {
    setLoading(true);
    try {
      const { name, body } = parseCommand(command);
      const data = await invokeFn(name, body);
      setOutput(JSON.stringify(data, null, 2));
      toast.success("API 已返回");
    } catch (e) {
      const msg = (e as Error).message;
      setOutput(JSON.stringify({ error: msg }, null, 2));
      toast.error(`测试失败：${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const exportGmvMax = async () => {
    if (!advertiserId || !startDate || !endDate) {
      toast.error("请填写广告户 ID、起止日期");
      return;
    }
    setExporting(true);
    try {
      const csv = await invokeFn<string>("gmv-max-raw-export", {
        advertiser_id: advertiserId.trim(), start_date: startDate, end_date: endDate,
      }, { timeout: 120000 });
      const fileName = `gmv-max-${advertiserId.trim()}-${startDate}_${endDate}.csv`;
      downloadText(csv, fileName);
      setOutput(JSON.stringify({ exported: true, file_name: fileName, scope: "GMV Max / PRODUCT_GMV_MAX" }, null, 2));
      toast.success("CSV 已开始下载");
    } catch (e) {
      const msg = (e as Error).message;
      setOutput(JSON.stringify({ error: msg }, null, 2));
      toast.error(`导出失败：${msg}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">API测试</h2>
        <p className="text-sm text-muted-foreground mt-1">通用函数调用、JSON 回传，以及按广告户与日期范围下载 GMV Max 原始报表。</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">GMV Max 原始 CSV 导出</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">只读，不会修改同步数据；范围限单广告户、最多 31 天。导出字段以 TikTok API 当前返回为准，仅包含 PRODUCT_GMV_MAX。</p>
          <div className="flex flex-wrap gap-2">
            <Input value={advertiserId} onChange={(e) => setAdvertiserId(e.target.value)} placeholder="广告户 ID" className="w-56" />
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            <Button onClick={exportGmvMax} disabled={exporting}><Download className="h-4 w-4 mr-1" />{exporting ? "导出中…" : "下载 CSV"}</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">通用查询指令</CardTitle>
          <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(command)}><Copy className="h-4 w-4 mr-1" />复制指令</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={command} onChange={(e) => setCommand(e.target.value)} className="min-h-32 font-mono text-xs" />
          <Button onClick={run} disabled={loading}><Play className="h-4 w-4 mr-1" />{loading ? "请求中…" : "执行测试"}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">回传内容</CardTitle>
          <Button size="sm" variant="outline" disabled={!output} onClick={() => { navigator.clipboard.writeText(output); toast.success("已复制回传内容"); }}><Copy className="h-4 w-4 mr-1" />复制回传</Button>
        </CardHeader>
        <CardContent><pre className="max-h-[520px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{output || "等待执行…"}</pre></CardContent>
      </Card>
    </div>
  );
}