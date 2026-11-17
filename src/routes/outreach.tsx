import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ttsApi, type TtsShop } from "@/lib/ttsApi";
import { SampleAdvicePanel } from "@/components/outreach/SampleAdvicePanel";

export const Route = createFileRoute("/outreach")({
  head: () => ({ meta: [{ title: "达人建联 - TikTok授权工具" }] }),
  component: OutreachPage,
});

// 达人建联（规则 docs/CREATOR_OWNERSHIP_RULES.md）：申样审核为第一个功能，后续群发/定向、收件箱、达人总表都放这里
function OutreachPage() {
  const [shops, setShops] = React.useState<TtsShop[]>([]);
  React.useEffect(() => {
    ttsApi.shops().then((r) => setShops(r.shops)).catch((e) => toast.error(`读取店铺失败：${(e as Error).message}`));
  }, []);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">达人建联</h2>
        <p className="text-sm text-muted-foreground mt-1">申样审核、达人外联与归属管理。规则见「达人归属与外联保护规则」。</p>
      </div>
      <Tabs defaultValue="samples">
        <TabsList>
          <TabsTrigger value="samples">申样审核</TabsTrigger>
        </TabsList>
        <TabsContent value="samples"><SampleAdvicePanel shops={shops} /></TabsContent>
      </Tabs>
    </div>
  );
}
