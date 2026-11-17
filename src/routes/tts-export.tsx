import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ttsApi, type TtsShop } from "@/lib/ttsApi";
import { runTtsExport, type TtsExportKind } from "@/lib/ttsExport";

export const Route = createFileRoute("/tts-export")({
  head: () => ({ meta: [{ title: "店铺数据导出 - TikTok授权工具" }] }),
  component: TtsExportPage,
});

// 各店铺「全店日常折扣」活动 ID 预设（可在页面修改，保存在本机浏览器）
const DEFAULT_ACTIVITY: Record<string, string> = { "8646920450261288950": "7656714354087446293" };
const LS_KEY = "tts-export-activity-ids";
function loadActivityIds(): Record<string, string> {
  try { return { ...DEFAULT_ACTIVITY, ...JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") }; } catch { return { ...DEFAULT_ACTIVITY }; }
}

const KINDS: Array<{ key: TtsExportKind; label: string; desc: string }> = [
  { key: "orders", label: "月度订单", desc: "按下单时间，每月一个 CSV，列同后台「订单导出」" },
  { key: "finance", label: "月度财务结算", desc: "按结算单生成时间，每月一个 xlsx（订单详情 + 对账单），订单维度" },
  { key: "affiliate", label: "月度联盟订单", desc: "按下单时间，每月拆成「达人」「服务商」两个 xlsx" },
  { key: "products", label: "最新商品 + 活动价", desc: "在售商品，后台批量编辑模板格式，最右加「活动价」" },
  { key: "samples", label: "申样审核建议", desc: "待审申样逐条给出 推荐批准 / 待审核 / 不批准 及理由（只读，不会审样）" },
];

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function TtsExportPage() {
  const [shops, setShops] = React.useState<TtsShop[]>([]);
  const [shopId, setShopId] = React.useState("");
  const [fromMonth, setFromMonth] = React.useState(lastMonth());
  const [toMonth, setToMonth] = React.useState(lastMonth());
  const [activityIds, setActivityIds] = React.useState<Record<string, string>>(loadActivityIds);
  const [busy, setBusy] = React.useState<TtsExportKind | null>(null);
  const [progress, setProgress] = React.useState("");
  const [output, setOutput] = React.useState("");

  React.useEffect(() => {
    ttsApi.shops().then((r) => {
      setShops(r.shops);
      if (r.shops[0]) setShopId((cur) => cur || r.shops[0].shop_id);
    }).catch((e) => toast.error(`读取店铺失败：${(e as Error).message}`));
  }, []);

  const shop = shops.find((s) => s.shop_id === shopId);
  const setActivity = (v: string) => {
    const next = { ...activityIds, [shopId]: v.trim() };
    setActivityIds(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* 隐私模式下忽略 */ }
  };

  const run = async (kind: TtsExportKind) => {
    if (!shop) { toast.error("请先选择店铺"); return; }
    setBusy(kind);
    setProgress("开始…");
    try {
      const s = await runTtsExport(kind, { shop_id: shop.shop_id, region: shop.region ?? shop.shop_id },
        { fromMonth, toMonth, activityId: activityIds[shopId] ?? "" }, setProgress);
      setOutput(JSON.stringify({ kind, shop: shop.region, complete: s.errors.length === 0, ...s }, null, 2));
      if (s.errors.length) toast.error(`已下载，但有 ${s.errors.length} 处错误，详见回传内容`);
      else toast.success(`已下载 ${s.files.length} 个文件，共 ${s.rows.toLocaleString()} 行`);
    } catch (e) {
      const msg = (e as Error).message;
      setOutput(JSON.stringify({ kind, error: msg }, null, 2));
      toast.error(`导出失败：${msg}`);
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">店铺数据导出</h2>
        <p className="text-sm text-muted-foreground mt-1">通过 TikTok Shop 接口只读导出，文件列名与卖家后台导出一致；时间按店铺本地时区。导出过程中请勿关闭页面。</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">参数</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={shopId} onChange={(e) => setShopId(e.target.value)}>
              {shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.region} · {s.shop_name ?? s.shop_id}</option>)}
            </select>
            <span className="text-sm text-muted-foreground">月份</span>
            <Input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} className="w-40" />
            <span className="text-sm text-muted-foreground">至</span>
            <Input type="month" value={toMonth} onChange={(e) => setToMonth(e.target.value)} className="w-40" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">全店折扣活动 ID</span>
            <Input value={activityIds[shopId] ?? ""} onChange={(e) => setActivity(e.target.value)} placeholder="该店铺的日常折扣活动 ID" className="w-64" />
            <span className="text-xs text-muted-foreground">仅「最新商品」使用，按店铺记在本机</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">导出</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {KINDS.map((k) => (
            <div key={k.key} className="flex flex-wrap items-center gap-3">
              <Button className="w-44" onClick={() => run(k.key)} disabled={busy !== null}>
                <Download className="h-4 w-4 mr-1" />{busy === k.key ? "导出中…" : k.label}
              </Button>
              <span className="text-xs text-muted-foreground">{k.desc}</span>
            </div>
          ))}
          {progress && <p className="text-xs text-muted-foreground pt-2">{progress}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">回传内容</CardTitle>
          <Button size="sm" variant="outline" disabled={!output} onClick={() => { navigator.clipboard.writeText(output); toast.success("已复制回传内容"); }}><Copy className="h-4 w-4 mr-1" />复制回传</Button>
        </CardHeader>
        <CardContent><pre className="max-h-[420px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{output || "等待导出…"}</pre></CardContent>
      </Card>
    </div>
  );
}
