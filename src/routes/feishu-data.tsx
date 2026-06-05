import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { invokeFn } from "@/lib/api";
import { toast } from "sonner";

export const Route = createFileRoute("/feishu-data")({
  head: () => ({ meta: [{ title: "飞书已获取数据 - TikTok授权工具" }] }),
  component: FeishuDataPage,
});

type StaffVidRow = { country: string | null; staff_name: string | null; vid: string; source_type: string; source_sheet: string | null; updated_at: string };
type SkuRow = { country: string | null; product_id: string; product_name: string | null; sku_id: string | null; merchant_sku: string | null; updated_at: string };

function FeishuDataPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">飞书已获取数据</h2>
        <p className="text-sm text-muted-foreground mt-1">查看已同步到数据库的 BD、剪辑素材与 SKU 匹配数据。</p>
      </div>
      <Tabs defaultValue="vids" className="space-y-4">
        <TabsList>
          <TabsTrigger value="vids">BD+剪辑素材表</TabsTrigger>
          <TabsTrigger value="sku">SKU匹配表</TabsTrigger>
        </TabsList>
        <TabsContent value="vids"><StaffVidPreview /></TabsContent>
        <TabsContent value="sku"><SkuPreview /></TabsContent>
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