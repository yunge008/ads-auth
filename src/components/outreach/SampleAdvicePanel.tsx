import * as React from "react";
import { Download, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { TtsShop } from "@/lib/ttsApi";
import {
  CACHE_MINUTES, cached, DEFAULT_SAMPLE_TH, downloadSampleXlsx, fetchSamples, groupByCreator, isFresh,
  type SampleRaw, type SampleThresholds,
} from "@/lib/sampleAdvice";

const ADVICE_STYLE: Record<string, string> = {
  "推荐批准": "bg-green-100 text-green-800", "待审核": "bg-amber-100 text-amber-800", "不批准": "bg-red-100 text-red-800",
};
const fmtNum = (v: number | null) => (v === null || Number.isNaN(v) ? "—" : v.toLocaleString());
const TH_KEY = "outreach-sample-thresholds";
function loadTh(): SampleThresholds {
  try { return { ...DEFAULT_SAMPLE_TH, ...JSON.parse(localStorage.getItem(TH_KEY) ?? "{}") }; } catch { return { ...DEFAULT_SAMPLE_TH }; }
}
const TH_FIELDS: Array<{ k: keyof SampleThresholds; label: string; unit: string }> = [
  { k: "max_fulfill_reject", label: "履约率低于", unit: "% → 不批准" },
  { k: "max_unfulfilled_reject", label: "本店发样未履约 ≥", unit: "次 → 不批准" },
  { k: "min_fulfill_ok", label: "推荐：履约率 ≥", unit: "%" },
  { k: "min_gmv_ok", label: "且 GMV ≥", unit: "" },
  { k: "min_followers_ok", label: "或 粉丝 ≥", unit: "" },
];

/** 待审申样在线浏览：一行一个达人，按站点（店铺）切换；阈值在本页改，改完立即重新分类、不重新读接口 */
export function SampleAdvicePanel({ shops }: { shops: TtsShop[] }) {
  const [shopId, setShopId] = React.useState("");
  const [raws, setRaws] = React.useState<SampleRaw[]>([]);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [prog, setProg] = React.useState<{ done: number; total: number | null }>({ done: 0, total: null });
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState("全部");
  const [th, setTh] = React.useState<SampleThresholds>(loadTh);
  const [draft, setDraft] = React.useState<SampleThresholds>(loadTh);
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 30_000); return () => clearInterval(t); }, []);
  React.useEffect(() => { if (!shopId && shops[0]) setShopId(shops[0].shop_id); }, [shops, shopId]);

  const showCache = (id: string) => {
    const c = cached(id);
    setRaws(c?.raws ?? []); setErrors(c?.errors ?? []); setFetchedAt(c?.complete ? c.fetchedAt : null);
    setProg(c ? { done: c.raws.length, total: c.raws.length } : { done: 0, total: null });
  };
  // 切店铺：有缓存就直接显示，没有就读
  React.useEffect(() => { if (shopId) { showCache(shopId); if (!cached(shopId)) void load(shopId, false); } }, [shopId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (id: string, force: boolean) => {
    if (!id || loading) return;
    if (!force && isFresh(cached(id))) { showCache(id); toast.info(`使用 ${CACHE_MINUTES} 分钟内已读取的数据`); return; }
    setLoading(true); setRaws([]); setErrors([]); setProg({ done: 0, total: null }); setFetchedAt(null);
    try {
      const e = await fetchSamples(id, (all, p, errs) => { setRaws([...all]); setErrors([...errs]); setProg(p); });
      setFetchedAt(e.fetchedAt);
      setProg({ done: e.raws.length, total: e.raws.length });
    } catch (e) {
      toast.error(`读取申样失败：${(e as Error).message}`);
    } finally { setLoading(false); }
  };

  const apply = () => {
    const next = { ...draft };
    for (const k of Object.keys(next) as Array<keyof SampleThresholds>) if (!Number.isFinite(Number(next[k]))) next[k] = DEFAULT_SAMPLE_TH[k];
    setTh(next);
    try { localStorage.setItem(TH_KEY, JSON.stringify(next)); } catch { /* 隐私模式忽略 */ }
  };
  const rows = React.useMemo(() => groupByCreator(raws, th), [raws, th]);
  const shown = filter === "全部" ? rows : rows.filter((r) => r.advice === filter);
  const count = (a: string) => rows.filter((r) => r.advice === a).length;
  const pct = prog.total ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : loading ? 3 : 0;
  const ageMin = fetchedAt ? Math.floor((Date.now() - fetchedAt) / 60_000) : null;
  const canRefetch = !fetchedAt || (ageMin ?? 0) >= CACHE_MINUTES;
  const shop = shops.find((s) => s.shop_id === shopId);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">待审申样 · 审核意见（只读，不会审样）</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={shopId} disabled={loading} onChange={(e) => setShopId(e.target.value)}>
            {shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.region} · {s.shop_name ?? s.shop_id}</option>)}
          </select>
          <Button onClick={() => load(shopId, true)} disabled={loading || !shopId || !canRefetch}
            title={canRefetch ? "重新从 TikTok 读取" : `${CACHE_MINUTES} 分钟内不重复读取接口`}>
            <RotateCw className="h-4 w-4 mr-1" />{loading ? "读取中…" : canRefetch ? "重新读取" : `${CACHE_MINUTES - (ageMin ?? 0)} 分钟后可重新读取`}
          </Button>
          <Button variant="outline" disabled={loading || !raws.length} onClick={() => downloadSampleXlsx(raws, th, shop?.region ?? shopId)}>
            <Download className="h-4 w-4 mr-1" />导出 xlsx
          </Button>
          {fetchedAt && <span className="text-xs text-muted-foreground">数据读取于 {new Date(fetchedAt).toLocaleTimeString()}（{ageMin} 分钟前）</span>}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{loading ? `读取中：已处理 ${prog.done}${prog.total ? ` / ${prog.total}` : ""} 条申样，已显示 ${rows.length} 位达人` : raws.length ? `共 ${raws.length} 条申样、${rows.length} 位达人` : "尚未读取"}</span>
            <span>{pct}%</span>
          </div>
          <Progress value={pct} className="h-3" />
        </div>

        <div className="rounded-md border p-3 space-y-2">
          <div className="text-xs font-medium">审核规则阈值（改完点「应用」立即重新分类，不重新读取接口；按顺序判断，命中即停）</div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {TH_FIELDS.map((f) => (
              <label key={f.k} className="flex items-center gap-1">
                <span className="text-muted-foreground">{f.label}</span>
                <Input type="number" className="h-8 w-20" value={draft[f.k]} onChange={(e) => setDraft({ ...draft, [f.k]: Number(e.target.value) })} />
                <span className="text-muted-foreground">{f.unit}</span>
              </label>
            ))}
            <Button size="sm" onClick={apply}>应用</Button>
            <Button size="sm" variant="ghost" onClick={() => { setDraft({ ...DEFAULT_SAMPLE_TH }); }}>恢复默认</Button>
          </div>
          <div className="text-xs text-muted-foreground">
            顺序：①平台标记不可审批 → 不批准；②本店已发样未履约次数达标 → 不批准；③履约率低于下限 → 不批准；④履约率达推荐线（或无记录）且 GMV 或粉丝达标 → 推荐批准；⑤其余 → 待审核。同一达人多条申样取最保守结论。
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {["全部", "推荐批准", "待审核", "不批准"].map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
              {f} {f === "全部" ? rows.length : count(f)}
            </Button>
          ))}
        </div>
        {errors.length > 0 && <p className="text-xs text-red-600">有 {errors.length} 处读取失败（如部分达人表现数据），首条：{errors[0]}</p>}
        <p className="text-xs text-muted-foreground">GMV、销量、带货率、播放为 TikTok 达人广场接口口径（统计窗口、币种以平台为准，未核验是否为近 30 天、美元）；「本店」列按本店历史申样计算。</p>
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
              {!shown.length && <tr><td colSpan={11} className="px-2 py-6 text-center text-muted-foreground">{loading ? "读取中，第一批读完就会显示…" : "暂无数据"}</td></tr>}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
