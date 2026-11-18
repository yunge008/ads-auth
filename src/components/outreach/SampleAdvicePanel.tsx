import * as React from "react";
import { Download, HelpCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import type { TtsShop } from "@/lib/ttsApi";
import {
  CACHE_MINUTES, cached, type Cond, DEFAULT_RULES, downloadSampleXlsx, fetchSamples, groupByCreator, isFresh,
  type Mark, type RegItem, type SampleRaw, type SampleRules,
} from "@/lib/sampleAdvice";

const ADVICE_STYLE: Record<string, string> = {
  "推荐批准": "bg-green-600 text-white", "待审核": "bg-amber-500 text-white", "不批准": "bg-red-600 text-white",
};
const MARK_STYLE: Record<Mark, string> = { pass: "bg-green-50 text-green-700 font-medium", fail: "bg-red-50 text-red-700 font-medium", none: "" };
const fmt = (v: number | null, d = 0) => (v === null || Number.isNaN(v) ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d }));
const RULES_KEY = "outreach-sample-rules-v2";
function loadRules(): SampleRules {
  try { return { ...DEFAULT_RULES, ...JSON.parse(localStorage.getItem(RULES_KEY) ?? "{}") }; } catch { return { ...DEFAULT_RULES }; }
}

function CondInput({ c, onChange, pre, post, w = "w-16" }: { c: Cond; onChange: (c: Cond) => void; pre: string; post?: string; w?: string }) {
  return (
    <label className="flex items-center gap-1 whitespace-nowrap">
      <Checkbox checked={c.on} onCheckedChange={(v) => onChange({ ...c, on: v === true })} />
      <span className={c.on ? "" : "text-muted-foreground"}>{pre}</span>
      <Input type="number" className={`h-7 ${w} px-1.5`} value={c.v} disabled={!c.on} onChange={(e) => onChange({ ...c, v: Number(e.target.value) })} />
      {post && <span className={c.on ? "" : "text-muted-foreground"}>{post}</span>}
    </label>
  );
}

/** 待审申样：一行一个达人，按店铺切换；条件在本页勾选/修改，立即在浏览器内重新分类，不重新读接口 */
export function SampleAdvicePanel({ shops }: { shops: TtsShop[] }) {
  const [shopId, setShopId] = React.useState("");
  const [raws, setRaws] = React.useState<SampleRaw[]>([]);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [diag, setDiag] = React.useState<{ stale: boolean; missing: string[] }>({ stale: false, missing: [] });
  const [loading, setLoading] = React.useState(false);
  const [prog, setProg] = React.useState<{ done: number; total: number | null }>({ done: 0, total: null });
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState("全部");
  const [rules, setRulesState] = React.useState<SampleRules>(loadRules);
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 30_000); return () => clearInterval(t); }, []);
  React.useEffect(() => { if (!shopId && shops[0]) setShopId(shops[0].shop_id); }, [shops, shopId]);

  const setRules = (r: SampleRules) => {
    setRulesState(r);
    try { localStorage.setItem(RULES_KEY, JSON.stringify(r)); } catch { /* 隐私模式忽略 */ }
  };
  const showCache = (id: string) => {
    const c = cached(id);
    setRaws(c?.raws ?? []); setErrors(c?.errors ?? []); setFetchedAt(c?.complete ? c.fetchedAt : null);
    setDiag({ stale: !!c?.staleBackend, missing: c?.missingCurrencies ?? [] });
    setProg(c ? { done: c.raws.length, total: c.raws.length } : { done: 0, total: null });
  };
  const load = async (id: string, force: boolean) => {
    if (!id || loading) return;
    if (!force && isFresh(cached(id))) { showCache(id); return; }
    setLoading(true); setRaws([]); setErrors([]); setProg({ done: 0, total: null }); setFetchedAt(null);
    try {
      const e = await fetchSamples(id, (all, p, errs) => {
        setRaws([...all]); setErrors([...errs]); setProg(p);
        const c = cached(id);
        setDiag({ stale: !!c?.staleBackend, missing: [...(c?.missingCurrencies ?? [])] });
      });
      setFetchedAt(e.fetchedAt);
      setProg({ done: e.raws.length, total: e.raws.length });
    } catch (e) {
      toast.error(`读取申样失败：${(e as Error).message}`);
    } finally { setLoading(false); }
  };
  React.useEffect(() => { if (shopId) { showCache(shopId); if (!cached(shopId)) void load(shopId, false); } }, [shopId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = React.useMemo(() => groupByCreator(raws, rules), [raws, rules]);
  const shown = filter === "全部" ? rows : rows.filter((r) => r.advice === filter);
  const count = (a: string) => rows.filter((r) => r.advice === a).length;
  const pct = prog.total ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : loading ? 2 : raws.length ? 100 : 0;
  const ageMin = fetchedAt ? Math.floor((Date.now() - fetchedAt) / 60_000) : null;
  const canRefetch = !fetchedAt || (ageMin ?? 0) >= CACHE_MINUTES;
  const shop = shops.find((s) => s.shop_id === shopId);
  const set = (k: keyof SampleRules) => (c: Cond) => setRules({ ...rules, [k]: c });

  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        {/* 第 1 行：店铺 / 读取 / 导出 / 说明 */}
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={shopId} disabled={loading} onChange={(e) => setShopId(e.target.value)}>
            {shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.region} · {s.shop_name ?? s.shop_id}</option>)}
          </select>
          <Button size="sm" onClick={() => load(shopId, true)} disabled={loading || !shopId || !canRefetch}
            title={canRefetch ? "重新从 TikTok 读取" : `${CACHE_MINUTES} 分钟内不重复读取接口`}>
            <RotateCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />{loading ? "读取中" : canRefetch ? "重新读取" : `${CACHE_MINUTES - (ageMin ?? 0)} 分钟后可重读`}
          </Button>
          <Button size="sm" variant="outline" disabled={loading || !raws.length} onClick={() => downloadSampleXlsx(raws, rules, shop?.region ?? shopId)}>
            <Download className="h-4 w-4 mr-1" />导出
          </Button>
          {fetchedAt && <span className="text-xs text-muted-foreground">读取于 {new Date(fetchedAt).toLocaleTimeString()}</span>}
          <Popover>
            <PopoverTrigger asChild><Button size="sm" variant="ghost" className="h-8 w-8 p-0"><HelpCircle className="h-4 w-4" /></Button></PopoverTrigger>
            <PopoverContent className="w-96 text-xs space-y-2">
              <div className="font-medium">判定顺序</div>
              <div>① 勾选的「不批准」条件任一命中 → <b>不批准</b>；② 否则勾选的「推荐」条件<b>全部满足</b> → <b>推荐批准</b>；③ 其余 → <b>待审核</b>。未勾选的条件不参与。同一达人申请多个商品时取最保守的结论。</div>
              <div>表格里绿色 = 满足该条件，红色 = 不满足或命中不批准，无色 = 未勾选相关条件。</div>
              <div className="font-medium">数据来源</div>
              <div>粉丝、GMV、销量、履约率、带货率：TikTok 接口（GMV 为本币，按「设置 → 汇率设置」折美元；统计窗口以平台为准，未核验是否近 30 天）。</div>
              <div>发样 / 出素材：飞书建联表（同站点池所有同事，PH/PH2/PHL 合并），每晚同步；发样超过 14 天仍无 VID 算「未出素材」。</div>
              <div>商家 SKU：飞书「SKU匹配表-TK」，每晚同步。</div>
              <div>改条件立即重新分类，不重新读接口；同一店铺 {CACHE_MINUTES} 分钟内不重复读取。只给建议，不会审样。</div>
            </PopoverContent>
          </Popover>
          <div className="ml-auto flex flex-wrap gap-1">
            {["全部", "推荐批准", "待审核", "不批准"].map((f) => (
              <Button key={f} size="sm" className="h-7 px-2" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
                {f} {f === "全部" ? rows.length : count(f)}
              </Button>
            ))}
          </div>
        </div>

        {/* 进度条 */}
        <div className="flex items-center gap-2">
          <Progress value={pct} className="h-2.5 flex-1" />
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {loading ? `已处理 ${prog.done}${prog.total ? `/${prog.total}` : ""} 条 · ${rows.length} 位达人` : raws.length ? `${raws.length} 条申样 · ${rows.length} 位达人` : "未读取"} · {pct}%
          </span>
        </div>

        {/* 条件（勾选才生效） */}
        <div className="rounded-md border px-3 py-2 space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="font-medium text-red-700 w-24">不批准（任一）</span>
            <label className="flex items-center gap-1 whitespace-nowrap">
              <Checkbox checked={rules.rejectNotApprovable} onCheckedChange={(v) => setRules({ ...rules, rejectNotApprovable: v === true })} />平台不可审批
            </label>
            <CondInput c={rules.rejectFulfillBelow} onChange={set("rejectFulfillBelow")} pre="履约率 <" post="%" />
            <CondInput c={rules.rejectUnfulfilled} onChange={set("rejectUnfulfilled")} pre="发样未出素材 ≥" post="次" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="font-medium text-green-700 w-24">推荐（全部满足）</span>
            <CondInput c={rules.okFulfill} onChange={set("okFulfill")} pre="履约率 ≥" post="%" />
            <label className="flex items-center gap-1 whitespace-nowrap text-muted-foreground">
              <Checkbox checked={rules.okNoFulfillPass} disabled={!rules.okFulfill.on} onCheckedChange={(v) => setRules({ ...rules, okNoFulfillPass: v === true })} />无履约记录算满足
            </label>
            <CondInput c={rules.okGmvUsd} onChange={set("okGmvUsd")} pre="GMV ≥ $" w="w-20" />
            <CondInput c={rules.okFollowers} onChange={set("okFollowers")} pre="粉丝 ≥" w="w-20" />
            <CondInput c={rules.okUnits} onChange={set("okUnits")} pre="销量 ≥" post="件" />
            <Button size="sm" variant="ghost" className="h-7 px-2 ml-auto" onClick={() => setRules({ ...DEFAULT_RULES })}>恢复默认</Button>
          </div>
        </div>

        {diag.stale && <p className="text-xs text-red-600">后台函数 tts-export 还是旧版本（没有 GMV 美元、建联表、商家 SKU 等新列），请让 Lovable 重新部署 tts-export 后再「重新读取」。</p>}
        {diag.missing.length > 0 && <p className="text-xs text-red-600">「设置 → 汇率设置」缺少或未启用这些币种的汇率：{diag.missing.join("、")}，对应达人的 GMV 无法折美元（表里显示本币，标黄）。</p>}
        {errors.length > 0 && <p className="text-xs text-red-600">有 {errors.length} 处读取失败，首条：{errors[0]}</p>}

        <div className="overflow-auto rounded-md border max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="bg-muted/60 text-muted-foreground sticky top-0">
              <tr>{["意见", "达人", "粉丝", "GMV(USD)", "销量", "履约率", "发样/出素材/未出", "带货率", "视频均播", "申样 SKU", "理由"].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.appIds[0]} className="border-t align-top hover:bg-muted/30">
                  <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 whitespace-nowrap ${ADVICE_STYLE[r.advice] ?? ""}`}>{r.advice}</span></td>
                  <td className={`px-2 py-1.5 ${r.marks.approvable === "fail" ? MARK_STYLE.fail : ""}`}>
                    <div className="flex items-center gap-2 min-w-44">
                      {r.avatar ? <img src={r.avatar} alt="" className="h-7 w-7 rounded-full object-cover" referrerPolicy="no-referrer" /> : <div className="h-7 w-7 rounded-full bg-muted" />}
                      <div className="leading-tight">
                        <div className="font-medium text-foreground">{r.nickname || r.username}</div>
                        <div className="text-muted-foreground">@{r.username}{r.ttUid ? ` · ID ${r.ttUid}` : ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${MARK_STYLE[r.marks.followers]}`}>{fmt(r.followers)}</td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${MARK_STYLE[r.marks.gmv]}`} title={r.gmvLocal !== null ? `${fmt(r.gmvLocal, 2)} ${r.currency}` : "接口未返回 GMV"}>
                    {r.gmvUsd !== null ? `$${fmt(r.gmvUsd)}` : r.gmvLocal !== null ? <span className="rounded bg-amber-100 px-1 text-amber-800">{fmt(r.gmvLocal)} {r.currency || "本币"}</span> : "—"}
                  </td>
                  <td className={`px-2 py-1.5 ${MARK_STYLE[r.marks.units]}`}>{fmt(r.units)}</td>
                  <td className={`px-2 py-1.5 ${MARK_STYLE[r.marks.fulfill]}`}>{r.fulfill === null ? "无" : `${r.fulfill}%`}</td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${MARK_STYLE[r.marks.unfulfilled]}`}>
                    <HoverCard openDelay={150}>
                      <HoverCardTrigger asChild>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                          {r.regSamples} / {r.regVid} / {r.regOpen}{r.regStaff ? <div className="text-muted-foreground font-normal no-underline">{r.regStaff}</div> : null}
                        </span>
                      </HoverCardTrigger>
                      <HoverCardContent align="start" className="w-auto max-w-[640px] p-2"><RegHistory items={r.regItems} /></HoverCardContent>
                    </HoverCard>
                  </td>
                  <td className="px-2 py-1.5">{fmt(r.postRate, 2)}</td>
                  <td className="px-2 py-1.5">{fmt(r.plays)}</td>
                  <td className="px-2 py-1.5 min-w-32" title={r.apps.map((a) => a.product).join("\n")}>{r.skus.join("、")}</td>
                  <td className="px-2 py-1.5 min-w-56 text-muted-foreground">{r.reasons}</td>
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

const ST_STYLE: Record<string, string> = { "已出素材": "text-green-700", "未出素材": "text-red-700", "拍摄中": "text-amber-700" };
/** 悬停：飞书建联表发样明细，固定 6 列，按发样日期倒序 */
function RegHistory({ items }: { items: RegItem[] }) {
  if (!items.length) return <div className="text-xs text-muted-foreground px-1">飞书建联表（同站点池）没有该达人的发样记录</div>;
  return (
    <div className="max-h-72 overflow-auto">
      <table className="text-xs">
        <thead className="text-muted-foreground sticky top-0 bg-popover">
          <tr>{["发样日期", "SKU", "同事", "状态", "VID", "视频发布"].map((h) => <th key={h} className="px-2 py-1 text-left font-medium whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody>
          {items.map((x, i) => (
            <tr key={i} className="border-t">
              <td className="px-2 py-1 whitespace-nowrap tabular-nums">{x.d}</td>
              <td className="px-2 py-1 whitespace-nowrap">{x.sku || "—"}</td>
              <td className="px-2 py-1 whitespace-nowrap">{x.staff}</td>
              <td className={`px-2 py-1 whitespace-nowrap font-medium ${ST_STYLE[x.st] ?? ""}`}>{x.st}</td>
              <td className="px-2 py-1 whitespace-nowrap tabular-nums">{x.vid ? <a className="underline" href={`https://www.tiktok.com/@artphro/video/${x.vid}`} target="_blank" rel="noreferrer">{x.vid}</a> : "—"}</td>
              <td className="px-2 py-1 whitespace-nowrap tabular-nums">{x.post || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-2 pt-1 text-[10px] text-muted-foreground">发样超过 14 天仍无 VID 记为「未出素材」，14 天内为「拍摄中」。</div>
    </div>
  );
}
