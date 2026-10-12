import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Play, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { invokeFn } from "@/lib/api";
import { downloadGmvMaxCsv, downloadGmvMaxXlsx, fetchGmvMaxRange } from "@/lib/gmvMaxExport";
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

function ApiTestPage() {
  const [command, setCommand] = React.useState(sample);
  const [output, setOutput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [advertiserId, setAdvertiserId] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [progress, setProgress] = React.useState("");

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

  const exportGmvMax = async (format: "xlsx" | "csv") => {
    const adv = advertiserId.trim();
    if (!adv || !startDate || !endDate) {
      toast.error("请填写广告户 ID、起止日期");
      return;
    }
    if (startDate > endDate) {
      toast.error("起始日期不能晚于结束日期");
      return;
    }
    setExporting(true);
    setProgress("正在拉取 campaign 列表…");
    try {
      const result = await fetchGmvMaxRange(
        { advertiser_id: adv, start_date: startDate, end_date: endDate },
        (p) => setProgress(`已完成 ${p.done}/${p.total} 个 campaign，累计 ${p.rows.toLocaleString()} 行`),
      );
      const fileName = `gmv-max-${adv}-${startDate}_${endDate}.${format}`;
      if (format === "xlsx") downloadGmvMaxXlsx(result.rows, fileName, result.mismatches);
      else downloadGmvMaxCsv(result.rows, fileName);
      const complete = result.errors.length === 0;
      setOutput(JSON.stringify({
        exported: true, file_name: fileName, rows: result.rows.length, calls: result.calls,
        complete, errors: result.errors,
        reconciliation: result.reconciled
          ? (result.mismatches.length ? { status: "有差异（明细合计 ≠ campaign 汇总，仅供参考）", mismatches: result.mismatches } : { status: "一致" })
          : { status: "无法对账（campaign 汇总查询失败）" },
      }, null, 2));
      if (complete) toast.success(`已下载 ${result.rows.length.toLocaleString()} 行`);
      else toast.error(`已下载，但有 ${result.errors.length} 处拉取失败，数据不完整，详见回传内容`);
    } catch (e) {
      const msg = (e as Error).message;
      setOutput(JSON.stringify({ error: msg }, null, 2));
      toast.error(`导出失败：${msg}`);
    } finally {
      setExporting(false);
      setProgress("");
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
          <p className="text-xs text-muted-foreground">只读，不会修改同步数据；单广告户、最多 365 天（自动按 30 天切窗、分批续拉，大户也能导完整）。按 campaign × 商品组 × 视频 × 天输出，字段以 TikTok API 当前返回为准，仅包含 PRODUCT_GMV_MAX；已删除的 campaign 也会导出（状态列显示 NOT_LISTED）。导出后自动与 campaign 级汇总对账，结果见「回传内容」。Excel 版 ID 列为文本，不会丢精度。</p>
          <div className="flex flex-wrap gap-2">
            <Input value={advertiserId} onChange={(e) => setAdvertiserId(e.target.value)} placeholder="广告户 ID" className="w-56" />
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            <Button onClick={() => exportGmvMax("xlsx")} disabled={exporting}><Download className="h-4 w-4 mr-1" />{exporting ? "导出中…" : "下载 Excel"}</Button>
            <Button variant="outline" onClick={() => exportGmvMax("csv")} disabled={exporting}>下载 CSV</Button>
          </div>
          {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">通用查询指令</CardTitle>
          <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(command)}><Copy className="h-4 w-4 mr-1" />复制指令</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            例：<code>gmv-max-adgroup-create {"{...}"}</code> 会真实调用 TikTok <code>/campaign/gmv_max/create/</code>
            新建 GMV Max 广告组（含预算/商品/出价，TikTok 侧无独立广告组接口，campaign create 即等价物），会产生真实花费；
            函数只透传请求体，不校验字段，需按 TikTok GMV Max Campaign Create 文档手填完整 JSON（含 advertiser_id、request_id 等必填项）；
            <code>request_id</code> 必须是能解析成 int64 的纯数字字符串（不能用 UUID）；
            <code>roas_bid</code>、<code>budget</code> 必须是数字类型（不能加引号）；
            <code>advertiser_id</code> 对应的 TikTok App 需已获得 GMV Max Campaign Management 写权限，否则报 code=40001。
          </p>
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