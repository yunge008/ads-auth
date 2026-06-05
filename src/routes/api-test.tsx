import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Play, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { invokeFn } from "@/lib/api";
import { toast } from "sonner";

export const Route = createFileRoute("/api-test")({
  head: () => ({ meta: [{ title: "API测试 - TikTok授权工具" }] }),
  component: ApiTestPage,
});

const sample = `tiktok-comments-sync {"advertiser_ids":["7589499008310345744"],"start_date":"2026-06-01","end_date":"2026-06-05","incremental":false,"max_pages":1,"debug":true}`;

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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">API测试</h2>
        <p className="text-sm text-muted-foreground mt-1">输入函数名和 JSON 参数，查看原始回传内容。</p>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">查询指令</CardTitle>
          <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(command)}>
            <Copy className="h-4 w-4 mr-1" />复制指令
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={command} onChange={(e) => setCommand(e.target.value)} className="min-h-32 font-mono text-xs" />
          <Button onClick={run} disabled={loading}>
            <Play className="h-4 w-4 mr-1" />{loading ? "请求中…" : "执行测试"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">回传内容</CardTitle></CardHeader>
        <CardContent>
          <pre className="max-h-[520px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{output || "等待执行…"}</pre>
        </CardContent>
      </Card>
    </div>
  );
}