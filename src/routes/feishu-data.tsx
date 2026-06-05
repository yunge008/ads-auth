import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, ChevronLeft, ChevronRight, Database, RotateCw } from "lucide-react";
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
  country: string | null; advertiser_id: string; vid: string; item_id: string | null; stat_date: string;
  tt_account_name: string | null; tt_account_authorization_type: string | null; shop_content_type: string | null;
  creative_delivery_status: string | null;
  cost: number; orders: number; gross_revenue: number;
  product_impressions: number; product_clicks: number;
  roi: number | null; ctr: number | null; cvr: number | null;
  ad_video_view_rate_2s: number | null; ad_video_view_rate_6s: number | null;
  ad_video_view_rate_p25: number | null; ad_video_view_rate_p50: number | null;
  ad_video_view_rate_p75: number | null; ad_video_view_rate_p100: number | null;
};
const pct = (v: number | null | undefined) => v == null ? "—" : (Number(v) * 100).toFixed(2) + "%";

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
  const preview = usePreview<GmvRow>("gmv_max_vid_daily");
  const [nameMap, setNameMap] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    invokeFn<{ rows: { advertiser_id: string; advertiser_name: string | null }[] }>(
      "data-preview", { table: "advertiser_countries", page: 1, page_size: 500 },
    ).then((r) => {
      const m = new Map<string, string>();
      for (const a of r.rows ?? []) if (a.advertiser_name) m.set(a.advertiser_id, a.advertiser_name);
      setNameMap(m);
    }).catch(() => {});
  }, []);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const r = (await work()) as Record<string, unknown>;
      const summary = Object.entries(r).filter(([k]) => k !== "errors").map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`).join(" / ");
      toast.success(`${label} 完成：${summary}`);
      const errs = (r as { errors?: { error: string }[] }).errors;
      if (errs?.length) toast.warning(`${errs.length} 条错误：${errs[0].error}`);
      preview.reload();
    } catch (e) {
      toast.error(`${label} 失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

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
            <Button size="sm" disabled={!!busy} onClick={() => run("GMV Max 回溯", () => invokeFn<Record<string, unknown>>("gmv-max-sync", { start_date: start, end_date: end }))}>
              <Database className={`h-4 w-4 mr-1.5 ${busy === "GMV Max 回溯" ? "animate-spin" : ""}`} />
              开始回溯
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => {
              const e2 = today;
              const s2 = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
              run("拉取最近3天", () => invokeFn<Record<string, unknown>>("gmv-max-sync", { start_date: s2, end_date: e2 }));
            }}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${busy === "拉取最近3天" ? "animate-spin" : ""}`} />
              最近3天
            </Button>
          </div>
        </CardContent>
      </Card>
      <PreviewCard title={`GMV Max 日报（${preview.count} 条）`} loading={preview.loading} reload={preview.reload} page={preview.page} count={preview.count} setPage={preview.setPage}>
        <Table>
          <TableHeader><TableRow>
            <TableHead>国家</TableHead><TableHead>广告户</TableHead>
            <TableHead>VID</TableHead><TableHead>TikTok账号名称</TableHead>
            <TableHead>授权类型</TableHead><TableHead>内容类型</TableHead>
            <TableHead>投放状态</TableHead><TableHead>日期</TableHead>
            <TableHead className="text-right">花费</TableHead><TableHead className="text-right">订单数</TableHead>
            <TableHead className="text-right">总收入GMV</TableHead>
            <TableHead className="text-right">PV</TableHead><TableHead className="text-right">Click</TableHead>
            <TableHead className="text-right">ROI</TableHead>
            <TableHead className="text-right">2秒播放率</TableHead><TableHead className="text-right">6秒播放率</TableHead>
            <TableHead className="text-right">25%播放率</TableHead><TableHead className="text-right">50%播放率</TableHead>
            <TableHead className="text-right">75%播放率</TableHead><TableHead className="text-right">完播率</TableHead>
          </TableRow></TableHeader>
          <TableBody>{preview.rows.map((r, i) => (
            <TableRow key={`${r.advertiser_id}-${r.vid}-${r.stat_date}-${i}`}>
              <TableCell>{r.country ?? "—"}</TableCell>
              <TableCell className="text-xs"><div>{nameMap.get(r.advertiser_id) ?? r.advertiser_id}</div><div className="text-[10px] text-muted-foreground font-mono">{r.advertiser_id}</div></TableCell>
              <TableCell className="font-mono text-xs">{r.vid}</TableCell>
              <TableCell className="text-xs">{r.tt_account_name ?? "—"}</TableCell>
              <TableCell className="text-xs">{r.tt_account_authorization_type ?? "—"}</TableCell>
              <TableCell className="text-xs">{r.shop_content_type ?? "—"}</TableCell>
              <TableCell className="text-xs">{r.creative_delivery_status ?? "—"}</TableCell>
              <TableCell className="text-xs">{r.stat_date}</TableCell>
              <TableCell className="text-right">{Number(r.cost).toFixed(2)}</TableCell>
              <TableCell className="text-right">{r.orders}</TableCell>
              <TableCell className="text-right">{Number(r.gross_revenue).toFixed(2)}</TableCell>
              <TableCell className="text-right">{r.product_impressions}</TableCell>
              <TableCell className="text-right">{r.product_clicks}</TableCell>
              <TableCell className="text-right">{r.roi == null ? "—" : Number(r.roi).toFixed(2)}</TableCell>
              <TableCell className="text-right">{pct(r.ad_video_view_rate_2s)}</TableCell>
              <TableCell className="text-right">{pct(r.ad_video_view_rate_6s)}</TableCell>
              <TableCell className="text-right">{pct(r.ad_video_view_rate_p25)}</TableCell>
              <TableCell className="text-right">{pct(r.ad_video_view_rate_p50)}</TableCell>
              <TableCell className="text-right">{pct(r.ad_video_view_rate_p75)}</TableCell>
              <TableCell className="text-right">{pct(r.ad_video_view_rate_p100)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </PreviewCard>
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
