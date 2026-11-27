import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertsPanel } from "@/components/reviews/AlertsPanel";
import { DataPanel } from "@/components/reviews/DataPanel";
import { CommentsView } from "@/components/reviews/CommentsView";
import { LinksTable } from "@/components/reviews/LinksTable";
import { TrendView } from "@/components/reviews/TrendView";
import { addDays, daysBetween, ListingLabel, yesterday } from "@/components/reviews/shared";
import { reviewsApi, type Meta, type ReviewText, type Series, type TableRow } from "@/lib/reviewsApi";

export const Route = createFileRoute("/reviews")({
  head: () => ({ meta: [{ title: "评论查看 - TikTok授权工具" }] }),
  component: ReviewsPage,
});

// Listing 评价监控（docs/LISTING_REVIEWS_PLAN.md）
const SITES = ["PH", "TH", "MY", "VN", "SG", "JP", "US", "MX-AR", "MX-NE", "MX-SJ", "PH2"];
const PRESETS = [7, 30, 90, 180];
const chip = (on: boolean) =>
  `h-7 rounded-full border px-3 text-xs transition-colors ${on ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-muted"}`;

function ReviewsPage() {
  const [tab, setTab] = React.useState("trend");
  const [meta, setMeta] = React.useState<Meta | null>(null);
  const [sites, setSites] = React.useState<Set<string>>(() => new Set(SITES));
  const [to, setTo] = React.useState(yesterday());
  const [from, setFrom] = React.useState(addDays(yesterday(), -29));
  const [q, setQ] = React.useState("");
  const [qDeb, setQDeb] = React.useState("");
  const [series, setSeries] = React.useState<Series | null>(null);
  const [rows, setRows] = React.useState<TableRow[] | null>(null);
  const [texts, setTexts] = React.useState<ReviewText[] | null>(null);
  const [stars, setStars] = React.useState<number[]>([]);

  // 数据版本：上传 / 同步 / 点刷新后 +1，清掉各处查询缓存
  const [ver, setVer] = React.useState(0);
  const loadMeta = React.useCallback(() => {
    reviewsApi.meta().then(setMeta).catch((e) => toast.error(`读取失败：${(e as Error).message}`));
  }, []);
  React.useEffect(loadMeta, [loadMeta]);
  React.useEffect(() => { const t = setTimeout(() => setQDeb(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  // 全选时传空数组（= 全部站点，查询更快）；一个都没选时不查
  const allOn = sites.size === SITES.length;
  const siteList = React.useMemo(() => (sites.size === SITES.length ? [] : sites.size === 0 ? ["-"] : SITES.filter((s) => sites.has(s))), [sites]);
  const noSite = sites.size === 0;
  // 查询结果按条件缓存：切回之前看过的站点/日期/筛选直接显示，不重新请求（数据每晚才更新；刷新页面即清空）
  const cache = React.useRef(new Map<string, { series: Series; rows: TableRow[] }>());
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (from > to) return;
    if (noSite) { setSeries({ base: [0, 0, 0, 0, 0], days: [], products: 0 }); setRows([]); setLoading(false); return; }
    const key = JSON.stringify([ver, siteList, from, to, qDeb]);
    const hit = cache.current.get(key);
    if (hit) { setSeries(hit.series); setRows(hit.rows); setLoading(false); return; }
    let stale = false;
    const span = daysBetween(from, to) + 1;
    setLoading(true); // 新数据回来前保留旧数据，不清空页面
    Promise.all([
      // 趋势多取一个同长度的上期，用于「较上期」
      reviewsApi.series({ sites: siteList, from: addDays(from, -span), to, q: qDeb }),
      reviewsApi.table({ sites: siteList, from, to, q: qDeb }),
    ]).then(([se, tb]) => {
      cache.current.set(key, { series: se, rows: tb.rows });
      if (!stale) { setSeries(se); setRows(tb.rows); }
    }).catch((e) => toast.error((e as Error).message)).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [siteList, from, to, qDeb, noSite, ver]);

  // 筛选框只匹配到一个 listing 时显示它的评价内容
  const single = rows && qDeb && rows.length === 1 ? rows[0] : null;
  React.useEffect(() => {
    if (!single) { setTexts(null); return; }
    let stale = false;
    reviewsApi.texts(single.pid, from, to, stars).then((r) => { if (!stale) setTexts(r.rows); }).catch((e) => toast.error((e as Error).message));
    return () => { stale = true; };
  }, [single?.pid, from, to, stars, ver]);

  const pickListing = (pid: string) => { setQ(pid); setQDeb(pid); setTab("trend"); window.scrollTo({ top: 0 }); };
  const preset = PRESETS.find((p) => to === yesterday() && daysBetween(from, to) + 1 === p);
  const skus = rows && qDeb ? rows.slice(0, 3) : [];

  return (
    <TooltipProvider delayDuration={150}>
      <Tabs value={tab} onValueChange={setTab} className="grid gap-3">
        <TabsList className="w-fit">
          <TabsTrigger value="trend">趋势</TabsTrigger>
          <TabsTrigger value="links">链接</TabsTrigger>
          <TabsTrigger value="comments">评论内容</TabsTrigger>
          <TabsTrigger value="alerts">差评提示</TabsTrigger>
          <TabsTrigger value="data">数据</TabsTrigger>
        </TabsList>

        {(tab === "trend" || tab === "links" || tab === "comments") && (
          <div className="grid gap-2" role="group" aria-label="筛选">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-8 shrink-0 text-xs text-muted-foreground" id="rv-lab-site">站点</span>
              <div className="flex flex-wrap gap-1" role="group" aria-labelledby="rv-lab-site">
                <button type="button" className={chip(allOn)} aria-pressed={allOn} onClick={() => setSites(allOn ? new Set() : new Set(SITES))}>全部</button>
                {SITES.map((s) => (
                  <button key={s} type="button" className={chip(sites.has(s))} aria-pressed={sites.has(s)}
                    onClick={() => setSites((old) => { const n = new Set(old); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>{s}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-8 shrink-0 text-xs text-muted-foreground" id="rv-lab-date">日期</span>
              <div className="flex flex-wrap gap-1" role="group" aria-labelledby="rv-lab-date">
                {PRESETS.map((p) => (
                  <button key={p} type="button" className={chip(preset === p)} aria-pressed={preset === p}
                    onClick={() => { const y = yesterday(); setTo(y); setFrom(addDays(y, -(p - 1))); }}>近 {p} 天</button>
                ))}
              </div>
              <Input id="rv-from" type="date" aria-label="开始日期" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 w-auto" />
              <span className="text-muted-foreground" aria-hidden>–</span>
              <Input id="rv-to" type="date" aria-label="结束日期" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 w-auto" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="rv-q" className="w-8 shrink-0 text-xs text-muted-foreground">筛选</label>
              <Input id="rv-q" type="search" placeholder="商品 ID / SKU / 名称" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-64" autoComplete="off" />
              <button type="button" aria-label="刷新数据" title="刷新数据" onClick={() => { setVer((v) => v + 1); loadMeta(); }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground">
                <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
                {noSite && <span>未选站点</span>}
                {loading && <span>更新中…</span>}
                {qDeb && !noSite && rows?.length === 0 && <span>无匹配</span>}
                {skus.map((r) => (
                  <span key={r.pid} className="max-w-[260px] rounded bg-muted px-1.5 py-0.5 text-foreground">
                    <ListingLabel sku={r.sku} title={r.title} pid={r.pid} showPid={false} />
                  </span>
                ))}
                {qDeb && (rows?.length ?? 0) > skus.length && <span>等 {rows!.length} 个</span>}
              </div>
            </div>
          </div>
        )}

        <TabsContent value="trend" forceMount className="mt-0 data-[state=inactive]:hidden">
          <TrendView series={series} from={from} to={to} texts={single ? texts : null} stars={stars} onStars={setStars} />
        </TabsContent>
        <TabsContent value="links" forceMount className="mt-0 data-[state=inactive]:hidden">
          <LinksTable rows={rows} onPick={pickListing} picked={single?.pid ?? null} from={from} to={to} />
        </TabsContent>
        <TabsContent value="comments" forceMount className="mt-0 data-[state=inactive]:hidden">
          <CommentsView ver={ver} active={tab === "comments"} sites={siteList} from={from} to={to} q={qDeb} onPick={pickListing} />
        </TabsContent>
        <TabsContent value="alerts" forceMount className="mt-0 data-[state=inactive]:hidden">
          <AlertsPanel ver={ver} meta={meta} onSaved={loadMeta} onPick={pickListing} />
        </TabsContent>
        <TabsContent value="data" forceMount className="mt-0 data-[state=inactive]:hidden">
          <DataPanel meta={meta} onChanged={() => { loadMeta(); setVer((v) => v + 1); }} />
        </TabsContent>
      </Tabs>
    </TooltipProvider>
  );
}
