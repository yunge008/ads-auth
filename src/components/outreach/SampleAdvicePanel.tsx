import * as React from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TtsShop } from "@/lib/ttsApi";
import { loadSampleAdvice, runTtsExport, type SampleCreatorRow } from "@/lib/ttsExport";

const ADVICE_STYLE: Record<string, string> = {
  "推荐批准": "bg-green-100 text-green-800", "待审核": "bg-amber-100 text-amber-800", "不批准": "bg-red-100 text-red-800",
};
const fmtNum = (v: number | null) => (v === null || Number.isNaN(v) ? "—" : v.toLocaleString());

/** 待审申样在线浏览：一行一个达人，按站点（店铺）切换 */
export function SampleAdvicePanel({ shops }: { shops: TtsShop[] }) {
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
          <Button variant="outline" disabled={loading || !shopId} onClick={async () => {
            const shop = shops.find((s) => s.shop_id === shopId);
            if (!shop) return;
            try {
              const r = await runTtsExport("samples", { shop_id: shop.shop_id, region: shop.region ?? shop.shop_id }, {}, setProgress);
              toast.success(`已下载 ${r.files[0]}`);
            } catch (e) { toast.error(`导出失败：${(e as Error).message}`); } finally { setProgress(""); }
          }}><Download className="h-4 w-4 mr-1" />导出 xlsx</Button>
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
