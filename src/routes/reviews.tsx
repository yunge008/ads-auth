import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertsPanel } from "@/components/reviews/AlertsPanel";
import { DataPanel } from "@/components/reviews/DataPanel";
import { CommentsView } from "@/components/reviews/CommentsView";
import { LinksTable } from "@/components/reviews/LinksTable";
import { TrendView } from "@/components/reviews/TrendView";
import { addDays, daysBetween, yesterday } from "@/components/reviews/shared";
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
  const [sites, setSites] = React.useState<Set<string>>(new Set());
  const [to, setTo] = React.useState(yesterday());
  const [from, setFrom] = React.useState(addDays(yesterday(), -29));
  const [q, setQ] = React.useState("");
  const [qDeb, setQDeb] = React.useState("");
  const [series, setSeries] = React.useState<Series | null>(null);
  const [rows, setRows] = React.useState<TableRow[] | null>(null);
  const [texts, setTexts] = React.useState<ReviewText[] | null>(null);
  const [stars, setStars] = React.useState<number[]>([]);

  const loadMeta = React.useCallback(() => {
    reviewsApi.meta().then(setMeta).catch((e) => toast.error(`读取失败：${(e as Error).message}`));
  }, []);
  React.useEffect(loadMeta, [loadMeta]);
  React.useEffect(() => { const t = setTimeout(() => setQDeb(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const siteList = React.useMemo(() => [...sites], [sites]);
  React.useEffect(() => {
    if (from > to) return;
    let stale = false;
    const span = daysBetween(from, to) + 1;
    setSeries(null);
    setRows(null);
    // 趋势多取一个同长度的上期，用于「较上期」
    reviewsApi.series({ sites: siteList, from: addDays(from, -span), to, q: qDeb })
      .then((r) => { if (!stale) setSeries(r); }).catch((e) => toast.error((e as Error).message));
    reviewsApi.table({ sites: siteList, from, to, q: qDeb })
      .then((r) => { if (!stale) setRows(r.rows); }).catch((e) => toast.error((e as Error).message));
    return () => { stale = true; };
  }, [siteList, from, to, qDeb]);

  // 筛选框只匹配到一个 listing 时显示它的评价内容
  const single = rows && qDeb && rows.length === 1 ? rows[0] : null;
  React.useEffect(() => {
    if (!single) { setTexts(null); return; }
    let stale = false;
    reviewsApi.texts(single.pid, from, to, stars).then((r) => { if (!stale) setTexts(r.rows); }).catch((e) => toast.error((e as Error).message));
    return () => { stale = true; };
  }, [single?.pid, from, to, stars]);

  const pickListing = (pid: string) => { setQ(pid); setQDeb(pid); setTab("trend"); window.scrollTo({ top: 0 }); };
  const preset = PRESETS.find((p) => to === yesterday() && daysBetween(from, to) + 1 === p);
  const skus = rows && qDeb ? rows.slice(0, 6) : [];

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
                <button type="button" className={chip(sites.size === 0)} aria-pressed={sites.size === 0} onClick={() => setSites(new Set())}>全部</button>
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
              <Input id="rv-q" type="search" placeholder="商品 ID" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-56 font-mono" autoComplete="off" />
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground min-w-0" aria-live="polite">
                {qDeb && rows?.length === 0 && <span>无匹配</span>}
                {skus.map((r) => <span key={r.pid} className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground" title={`${r.site} · ${r.pid}`}>{r.sku ?? r.pid}</span>)}
                {qDeb && (rows?.length ?? 0) > 6 && <span>等 {rows!.length} 个</span>}
              </div>
            </div>
          </div>
        )}

        <TabsContent value="trend" className="mt-0">
          <TrendView series={series} from={from} to={to} texts={single ? texts : null} stars={stars} onStars={setStars} />
        </TabsContent>
        <TabsContent value="links" className="mt-0">
          <LinksTable rows={rows} onPick={pickListing} picked={single?.pid ?? null} from={from} to={to} />
        </TabsContent>
        <TabsContent value="comments" className="mt-0">
          <CommentsView sites={siteList} from={from} to={to} q={qDeb} onPick={pickListing} />
        </TabsContent>
        <TabsContent value="alerts" className="mt-0">
          <AlertsPanel meta={meta} onSaved={loadMeta} onPick={pickListing} />
        </TabsContent>
        <TabsContent value="data" className="mt-0">
          <DataPanel meta={meta} onChanged={loadMeta} />
        </TabsContent>
      </Tabs>
    </TooltipProvider>
  );
}
