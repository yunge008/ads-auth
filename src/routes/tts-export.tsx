import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ttsApi, type TtsShop } from "@/lib/ttsApi";
import { loadSampleAdvice, runTtsExport, type SampleCreatorRow, type TtsExportKind } from "@/lib/ttsExport";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
      <Tabs defaultValue="export">
        <TabsList>
          <TabsTrigger value="export">文件导出</TabsTrigger>
          <TabsTrigger value="samples">申样审核意见</TabsTrigger>
        </TabsList>
        <TabsContent value="samples"><SampleAdvicePanel shops={shops} /></TabsContent>
        <TabsContent value="export" className="space-y-4">
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
        </TabsContent>
      </Tabs>
    </div>
  );
}

const ADVICE_STYLE: Record<string, string> = {
  "推荐批准": "bg-green-100 text-green-800", "待审核": "bg-amber-100 text-amber-800", "不批准": "bg-red-100 text-red-800",
};
const fmtNum = (v: number | null) => (v === null || Number.isNaN(v) ? "—" : v.toLocaleString());

/** 待审申样在线浏览：一行一个达人，按站点（店铺）切换 */
function SampleAdvicePanel({ shops }: { shops: TtsShop[] }) {
  const [shopId, setShopId] = React.useState("");
  const [rows, setRows] = React.useState<SampleCreatorRow[]>([]);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [filter, setFilter] = React.useState("全部");
  React.useEffect(() => { if (!shopId && shops[0]) setShopId(shops[0].shop_id); }, [shops, shopId]);

  const load = async (id: string) => {
    if (!id) return;
    setLoading(true); setRows([]); setErrors([]);
    try {
      const r = await loadSampleAdvice(id, setProgress);
      setRows(r.rows); setErrors(r.errors);
    } catch (e) {
      toast.error(`读取申样失败：${(e as Error).message}`);
    } finally { setLoading(false); setProgress(""); }
  };
  const shown = filter === "全部" ? rows : rows.filter((r) => r.advice === filter);
  const count = (a: string) => rows.filter((r) => r.advice === a).length;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">待审申样 · 审核意见（只读，不会审样）</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={shopId} onChange={(e) => { setShopId(e.target.value); load(e.target.value); }}>
            {shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.region} · {s.shop_name ?? s.shop_id}</option>)}
          </select>
          <Button onClick={() => load(shopId)} disabled={loading || !shopId}>{loading ? "读取中…" : "读取 / 刷新"}</Button>
          {["全部", "推荐批准", "待审核", "不批准"].map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
              {f}{f === "全部" ? ` ${rows.length}` : ` ${count(f)}`}
            </Button>
          ))}
        </div>
        {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
        {errors.length > 0 && <p className="text-xs text-red-600">有 {errors.length} 处读取失败（如部分达人表现数据），首条：{errors[0]}</p>}
        <p className="text-xs text-muted-foreground">GMV、销量、带货率、播放为 TikTok 达人广场接口口径（统计窗口以平台为准，未核验是否为近 30 天）；「本店」列按本店历史申样计算。</p>
        <div className="overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>{["审核意见", "达人", "粉丝", "GMV", "销量(件)", "履约率", "带货率", "视频平均播放", "本店发样/履约", "申样商品", "理由"].map((h) => <th key={h} className="px-2 py-2 text-left font-medium whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.appIds[0]} className="border-t align-top">
                  <td className="px-2 py-2"><span className={`rounded px-2 py-0.5 text-xs whitespace-nowrap ${ADVICE_STYLE[r.advice] ?? ""}`}>{r.advice}</span></td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2 min-w-40">
                      {r.avatar ? <img src={r.avatar} alt="" className="h-8 w-8 rounded-full object-cover" referrerPolicy="no-referrer" /> : <div className="h-8 w-8 rounded-full bg-muted" />}
                      <div><div className="font-medium">{r.nickname || r.username}</div><div className="text-xs text-muted-foreground">@{r.username}</div></div>
                    </div>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtNum(r.followers)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{fmtNum(r.gmv)} {r.currency}</td>
                  <td className="px-2 py-2">{fmtNum(r.units)}</td>
                  <td className="px-2 py-2">{r.fulfill === null ? "—" : `${r.fulfill}%`}</td>
                  <td className="px-2 py-2">{fmtNum(r.postRate)}</td>
                  <td className="px-2 py-2">{fmtNum(r.plays)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.shopShipped} / {r.shopFulfilled}</td>
                  <td className="px-2 py-2 min-w-48 text-xs">{r.products.join("；")}</td>
                  <td className="px-2 py-2 min-w-56 text-xs text-muted-foreground">{r.reasons}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={11} className="px-2 py-6 text-center text-muted-foreground">{loading ? "读取中…" : "点「读取 / 刷新」加载待审申样"}</td></tr>}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
