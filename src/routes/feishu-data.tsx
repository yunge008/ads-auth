import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, ChevronLeft, ChevronRight, Database, RotateCw, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { invokeFn } from "@/lib/api";
import { toast } from "sonner";
import { DateRangeQuickSelect } from "@/components/DateRangeQuickSelect";

export const Route = createFileRoute("/feishu-data")({
  head: () => ({ meta: [{ title: "已获取数据查阅 - TikTok授权工具" }] }),
  component: FeishuDataPage,
});

type StaffVidRow = { country: string | null; staff_name: string | null; vid: string; source_type: string; source_sheet: string | null; updated_at: string };
type SkuRow = { country: string | null; product_id: string; product_name: string | null; sku_id: string | null; merchant_sku: string | null; updated_at: string };
type GmvRow = {
  country: string | null; advertiser_id: string; vid: string; stat_date: string;
  tt_account_name: string | null; tt_account_authorization_type: string | null; shop_content_type: string | null;
  creative_delivery_status: string | null;
  cost: number; orders: number; gross_revenue: number;
  product_impressions: number; product_clicks: number;
};
type AdvertiserRow = { advertiser_id: string; advertiser_name: string | null; country: string | null; shop_id?: string | null };
type SyncResp = {
  upserted: number;
  advertisers: number;
  processed_advertisers: number;
  remaining_advertiser_ids: string[];
  advertiser_names?: Record<string, string>;
  batch_stats: Array<{ advertiser_id: string; campaigns: number; rows: number }>;
  errors: Array<{ advertiser_id: string; error: string }>;
};
type CountryStatus = "pending" | "running" | "success" | "failed" | "skipped";
type CountryProgressRow = {
  advertiser_id: string;
  country: string;
  advertiser_name?: string;
  status: CountryStatus;
  rows?: number;
  campaigns?: number;
  days?: number;
  error?: string;
};
const DELIVERY_STATUSES = ["IN_QUEUE", "LEARNING", "DELIVERING", "NOT_DELIVERYING", "NOT_ACTIVE", "AUTHORIZATION_NEEDED", "Unavailable", "Excluded", "Rejected"] as const;
const STATUS_LABELS: Record<string, string> = {
  IN_QUEUE: "排队中", LEARNING: "学习中", DELIVERING: "投放中", NOT_DELIVERYING: "未投放",
  NOT_ACTIVE: "不活跃", AUTHORIZATION_NEEDED: "需要授权", Unavailable: "不可用", Excluded: "已排除", Rejected: "已拒绝",
};
const daysBetweenInclusive = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000) + 1;

function FeishuDataPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">已获取数据查阅</h2>
        <p className="text-sm text-muted-foreground mt-1">查看已同步到数据库的 BD、剪辑素材、SKU 匹配与 GMV Max 数据。</p>
      </div>
      <Tabs defaultValue="vids" className="space-y-4">
        <TabsList>
          <TabsTrigger value="vids">BD+剪辑素材表</TabsTrigger>
          <TabsTrigger value="sku">SKU匹配表</TabsTrigger>
          <TabsTrigger value="gmv">GMV Max</TabsTrigger>
        </TabsList>
        <TabsContent value="vids"><StaffVidPreview /></TabsContent>
        <TabsContent value="sku"><SkuPreview /></TabsContent>
        <TabsContent value="gmv" className="space-y-4"><GmvMaxSection /></TabsContent>
      </Tabs>
    </div>
  );
}

function StaffVidPreview() {
  const { rows, count, page, loading, reload, setPage } = usePreview<StaffVidRow>("staff_vid_map");
  return (
    <PreviewCard title={`素材映射（${count} 条）`} loading={loading} reload={reload} page={page} count={count} setPage={setPage}>
      <Table>
        <TableHeader><TableRow><TableHead>国家</TableHead><TableHead>人员</TableHead><TableHead>VID</TableHead><TableHead>来源</TableHead><TableHead>Sheet</TableHead><TableHead>更新时间</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((r, i) => <TableRow key={`${r.vid}-${i}`}><TableCell>{r.country ?? "—"}</TableCell><TableCell>{r.staff_name ?? "—"}</TableCell><TableCell className="font-mono text-xs">{r.vid}</TableCell><TableCell>{r.source_type}</TableCell><TableCell>{r.source_sheet ?? "—"}</TableCell><TableCell className="text-xs">{r.updated_at?.slice(0, 19).replace("T", " ")}</TableCell></TableRow>)}</TableBody>
      </Table>
    </PreviewCard>
  );
}

function SkuPreview() {
  const { rows, count, page, loading, reload, setPage } = usePreview<SkuRow>("sku_product_map");
  return (
    <PreviewCard title={`SKU匹配（${count} 条）`} loading={loading} reload={reload} page={page} count={count} setPage={setPage}>
      <Table>
        <TableHeader><TableRow><TableHead>国家</TableHead><TableHead>商品ID</TableHead><TableHead>商品名称</TableHead><TableHead>SKU ID</TableHead><TableHead>商家SKU</TableHead><TableHead>更新时间</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((r, i) => <TableRow key={`${r.product_id}-${r.merchant_sku}-${i}`}><TableCell>{r.country ?? "—"}</TableCell><TableCell className="font-mono text-xs">{r.product_id}</TableCell><TableCell>{r.product_name ?? "—"}</TableCell><TableCell className="font-mono text-xs">{r.sku_id ?? "—"}</TableCell><TableCell>{r.merchant_sku ?? "—"}</TableCell><TableCell className="text-xs">{r.updated_at?.slice(0, 19).replace("T", " ")}</TableCell></TableRow>)}</TableBody>
      </Table>
    </PreviewCard>
  );
}

function GmvMaxSection() {
  const today = new Date().toISOString().slice(0, 10);
  const ago30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const [start, setStart] = React.useState(ago30);
  const [end, setEnd] = React.useState(today);
  const [busy, setBusy] = React.useState<string | null>(null);
  const reportRef = React.useRef<{ reload: () => void }>({ reload: () => {} });
  const [nameMap, setNameMap] = React.useState<Map<string, string>>(new Map());
  const [advertisers, setAdvertisers] = React.useState<AdvertiserRow[]>([]);
  const [countryRows, setCountryRows] = React.useState<Map<string, CountryProgressRow>>(new Map());
  const [progress, setProgress] = React.useState<{ label: string; current: string; done: number; total: number; attempt: number } | null>(null);

  const fetchAdvertisers = React.useCallback(async () => {
    const r = await invokeFn<{ rows: AdvertiserRow[] }>(
      "data-preview", { table: "advertiser_countries", page: 1, page_size: 500 },
    );
    const rows = r.rows ?? [];
    setAdvertisers(rows);
    setNameMap((prev) => {
      const next = new Map(prev);
      for (const a of rows) if (a.advertiser_name) next.set(a.advertiser_id, a.advertiser_name);
      return next;
    });
    return rows;
  }, []);

  React.useEffect(() => {
    fetchAdvertisers().catch(() => {});
  }, [fetchAdvertisers]);

  const nameOf = (id: string) => nameMap.get(id) ?? id;

  const mergeNames = (names?: Record<string, string>) => {
    if (!names) return;
    setNameMap((prev) => {
      const next = new Map(prev);
      for (const [id, name] of Object.entries(names)) if (name) next.set(id, name);
      return next;
    });
  };

  const updateCountryRow = (id: string, patch: Partial<CountryProgressRow>) => {
    setCountryRows((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { advertiser_id: id, country: "—", status: "pending" as CountryStatus };
      next.set(id, { ...cur, ...patch, advertiser_name: patch.advertiser_name ?? cur.advertiser_name ?? nameOf(id) });
      return next;
    });
  };

  const run = async (label: string, s: string, e: string) => {
    setBusy(label);
    setProgress(null);
    const source = advertisers.length ? advertisers : await fetchAdvertisers();
    const targets = source.sort((a, b) => String(a.country ?? "").localeCompare(String(b.country ?? "")));
    const days = daysBetweenInclusive(s, e);
    const initial = new Map<string, CountryProgressRow>();
    for (const adv of targets) {
      initial.set(adv.advertiser_id, {
        advertiser_id: adv.advertiser_id,
        country: adv.country ?? "—",
        advertiser_name: adv.advertiser_name ?? nameOf(adv.advertiser_id),
        status: "pending",
        days,
      });
    }
    setCountryRows(initial);
    try {
      let upserted = 0;
      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        const adv = targets[i];
        const country = adv.country ?? "—";
        updateCountryRow(adv.advertiser_id, { status: "running", error: undefined });
        let finished = false;
        for (let attempt = 1; attempt <= 3 && !finished; attempt++) {
          setProgress({ label, current: country, done: i, total: targets.length, attempt });
          try {
            const resp = await invokeFn<SyncResp>("gmv-max-sync", {
              start_date: s,
              end_date: e,
              advertiser_ids: [adv.advertiser_id],
              max_runtime_ms: 60000,
            });
            mergeNames(resp.advertiser_names);
            upserted += resp.upserted ?? 0;
            const stat = resp.batch_stats?.find((x) => x.advertiser_id === adv.advertiser_id);
            const err = resp.errors?.find((x) => x.advertiser_id === adv.advertiser_id);
            if (stat) {
              updateCountryRow(adv.advertiser_id, { status: "success", rows: stat.rows, campaigns: stat.campaigns, days });
              finished = true;
            } else if (err) {
              updateCountryRow(adv.advertiser_id, { status: err.error.includes("店铺ID") ? "skipped" : "failed", error: err.error, days });
              if (!err.error.includes("店铺ID")) failed++;
              finished = true;
            } else if (resp.remaining_advertiser_ids?.includes(adv.advertiser_id)) {
              updateCountryRow(adv.advertiser_id, { error: `第 ${attempt} 次仍在处理，继续重试` });
            } else {
              updateCountryRow(adv.advertiser_id, { status: "success", rows: 0, campaigns: 0, days });
              finished = true;
            }
          } catch (err) {
            updateCountryRow(adv.advertiser_id, { status: "failed", error: (err as Error).message, days });
            failed++;
            finished = true;
          }
        }
        if (!finished) {
          updateCountryRow(adv.advertiser_id, { status: "failed", error: "单个国家超过即时抓取时间预算，请单独重试", days });
          failed++;
        }
        setProgress({ label, current: country, done: i + 1, total: targets.length, attempt: 0 });
      }
      toast.success(`${label} 完成：${targets.length} 个国家 / 写入 ${upserted} 行${failed ? ` / ${failed} 个失败` : ""}`);
      reportRef.current.reload();
    } catch (e) {
      toast.error(`${label} 失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const progressRows = Array.from(countryRows.values()).sort((a, b) => {
    const order = { running: 0, pending: 1, failed: 2, skipped: 3, success: 4 } as Record<CountryStatus, number>;
    return order[a.status] - order[b.status] || a.country.localeCompare(b.country);
  });

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">GMV Max 回溯</CardTitle>
          <p className="text-xs text-muted-foreground">仅拉取在「设置 / 授权」中填写了店铺ID（shop_id）的广告户；超过 30 天自动按窗口拆分。</p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">起始</span>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">结束</span>
              <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 w-40" />
            </div>
            <DateRangeQuickSelect onPick={(s, e) => { setStart(s); setEnd(e); }} />
            <Button size="sm" disabled={!!busy} onClick={() => run("GMV Max 回溯", start, end)}>
              <Database className={`h-4 w-4 mr-1.5 ${busy === "GMV Max 回溯" ? "animate-spin" : ""}`} />
              开始回溯
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => {
              const e2 = today;
              const s2 = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
              run("拉取最近3天", s2, e2);
            }}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${busy === "拉取最近3天" ? "animate-spin" : ""}`} />
              最近3天
            </Button>
          </div>
          {progress && (
            <div className="mt-3 text-xs text-muted-foreground">
              {progress.label}：{progress.done} / {progress.total} · 当前 {progress.current}{progress.attempt ? ` · 第 ${progress.attempt} 次` : ""}
            </div>
          )}
          {progressRows.length > 0 && (
            <div className="mt-3 border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8">国家</TableHead>
                    <TableHead className="h-8">广告户</TableHead>
                    <TableHead className="h-8">状态</TableHead>
                    <TableHead className="h-8 text-right">天数</TableHead>
                    <TableHead className="h-8 text-right">行数</TableHead>
                    <TableHead className="h-8 text-right">广告</TableHead>
                    <TableHead className="h-8">信息</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {progressRows.map((r) => (
                    <TableRow key={r.advertiser_id}>
                      <TableCell className="py-1.5 font-medium">{r.country}</TableCell>
                      <TableCell className="py-1.5">
                        <div className="text-xs">{r.advertiser_name ?? nameOf(r.advertiser_id)}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">{r.advertiser_id}</div>
                      </TableCell>
                      <TableCell className="py-1.5">
                        {r.status === "success" && <span className="inline-flex items-center gap-1 text-xs text-foreground"><CheckCircle2 className="h-3.5 w-3.5" />成功</span>}
                        {r.status === "failed" && <span className="inline-flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3.5 w-3.5" />失败</span>}
                        {r.status === "skipped" && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" />跳过</span>}
                        {r.status === "pending" && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" />排队</span>}
                        {r.status === "running" && <span className="inline-flex items-center gap-1 text-xs text-primary"><Loader2 className="h-3.5 w-3.5 animate-spin" />抓取中</span>}
                      </TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">{r.days ?? "—"}</TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">{r.rows ?? "—"}</TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">{r.campaigns ?? "—"}</TableCell>
                      <TableCell className="py-1.5 text-xs text-muted-foreground max-w-[320px] truncate" title={r.error}>{r.error ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <GmvDailyReport advertisers={advertisers} />

    </>
  );
}

function usePreview<T>(table: string) {
  const [rows, setRows] = React.useState<T[]>([]);
  const [count, setCount] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await invokeFn<{ rows: T[]; count: number }>("data-preview", { table, page, page_size: 100 });
      setRows(r.rows ?? []);
      setCount(r.count ?? 0);
    } catch (e) { toast.error(`加载失败：${(e as Error).message}`); }
    finally { setLoading(false); }
  }, [table, page]);
  React.useEffect(() => { reload(); }, [reload]);
  return { rows, count, page, loading, reload, setPage };
}

function PreviewCard({ title, loading, reload, page, count, setPage, children }: { title: string; loading: boolean; reload: () => void; page: number; count: number; setPage: (v: number) => void; children: React.ReactNode }) {
  const pageCount = Math.max(1, Math.ceil(count / 100));
  return <Card><CardHeader className="flex flex-row items-center justify-between space-y-0"><CardTitle className="text-base">{title}</CardTitle><Button size="sm" variant="outline" onClick={reload} disabled={loading}><RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />刷新</Button></CardHeader><CardContent><div className="border rounded-md overflow-x-auto">{children}</div><div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground"><Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button><span>{page} / {pageCount}</span><Button size="sm" variant="outline" className="h-7" disabled={page >= pageCount} onClick={() => setPage(page + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button></div></CardContent></Card>;
}
