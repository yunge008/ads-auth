// 导入记录：服务端路由 gmv-max-write 把每次导入逐商品写进 gmv_max_import_logs；这里列批次、下载明细。
import * as React from "react";
import * as XLSX from "xlsx";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callGmvMaxWrite } from "@/lib/api";

export type ProductResult = { item_group_id: string; status: string; reason: string };
export type DetailRow = {
  campaign_name: string; new_campaign_id?: string | null; source_campaign_id?: string; advertiser_id: string; bc_id?: string;
  advertiser_name?: string; bc_name?: string;
  source_advertiser_id?: string; source_advertiser_name?: string; source_bc_id?: string; source_bc_name?: string;
  group_status: string; group_note: string; item_group_id: string; status: string; reason: string; created_at?: string;
};

export const DETAIL_HEADERS = ["计划名称", "新计划ID", "源计划ID", "来源广告户", "来源广告户ID", "来源BC", "来源BC ID",
  "去向广告户", "去向广告户ID", "去向BC", "去向BC ID", "商品ID", "状态", "原因", "组状态", "组备注", "时间"];

/** 「商品明细」sheet：一行一个商品，带自动筛选，可按状态筛 */
export function detailSheet(rows: DetailRow[]): XLSX.WorkSheet {
  const aoa = [DETAIL_HEADERS, ...rows.map((r) => [
    r.campaign_name, r.new_campaign_id ?? "", r.source_campaign_id ?? "",
    r.source_advertiser_name ?? "", r.source_advertiser_id ?? "", r.source_bc_name ?? "", r.source_bc_id ?? "",
    r.advertiser_name ?? "", r.advertiser_id, r.bc_name ?? "", r.bc_id ?? "",
    r.item_group_id, r.status, r.reason, r.group_status, r.group_note, r.created_at ? new Date(r.created_at).toLocaleString() : "",
  ])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 1; r < aoa.length; r++) for (const c of [1, 2, 4, 6, 8, 10, 11]) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell) { cell.t = "s"; cell.z = "@"; }
  }
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(aoa.length - 1, 0), c: DETAIL_HEADERS.length - 1 } }) };
  return ws;
}

export function newBatchId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type Batch = {
  batch_id: string; kind: string; source: string; operator: string; advertiser_id: string;
  advertiser_name?: string; bc_id?: string; bc_name?: string;
  source_advertiser_id?: string; source_advertiser_name?: string; source_bc_id?: string; source_bc_name?: string;
  first_at: string; last_at: string; groups: number; counts: Record<string, number>;
};
const KIND_LABEL: Record<string, string> = { excel: "Excel", copy: "复制", single: "单个" };

// 户名 + ID 一行，BC 名 + ID 一行（灰）
function AdvBc({ name, id, bcName, bcId }: { name?: string; id?: string; bcName?: string; bcId?: string }) {
  return (
    <div className="leading-tight">
      <div>{name || "—"} <span className="font-mono text-muted-foreground">{id}</span></div>
      <div className="text-muted-foreground">BC {bcName || (bcId ? "" : "—")} <span className="font-mono">{bcId}</span></div>
    </div>
  );
}

// advNames：页面已有的广告户名（库里 advertiser_name 为空时兜底）
export function ImportHistory({ refreshKey, advNames = {} }: { refreshKey: number; advNames?: Record<string, string> }) {
  const [batches, setBatches] = React.useState<Batch[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const d = await callGmvMaxWrite<{ batches: Batch[] }>({ action: "log_batches", days: 30 });
      setBatches(d.batches);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { void load(); }, [load, refreshKey]);

  const download = async (b: Batch) => {
    try {
      const d = await callGmvMaxWrite<{ rows: DetailRow[] }>({ action: "log_get", batch_id: b.batch_id });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, detailSheet(d.rows), "商品明细");
      XLSX.writeFile(wb, `导入记录-${new Date(b.last_at).toISOString().slice(0, 16).replace(/[:T]/g, "")}-${b.source || b.batch_id.slice(0, 8)}.xlsx`);
    } catch (e) {
      toast.error(`下载失败：${(e as Error).message}`);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">导入记录</CardTitle>
        <Button size="sm" variant="outline" onClick={load} disabled={loading} aria-label="刷新导入记录">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {err ? (
          <p role="alert" className="text-xs text-destructive">{/relation|does not exist|schema cache/i.test(err) ? "导入记录表未创建（需先执行 migration 20261124120000）" : err}</p>
        ) : !batches.length ? (
          <p className="text-xs text-muted-foreground">{loading ? "读取中…" : "近 30 天无记录"}</p>
        ) : (
          <div className="max-h-80 overflow-auto border rounded">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>方式</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>去向</TableHead>
                  <TableHead className="text-right">组</TableHead>
                  <TableHead className="text-right">成功</TableHead>
                  <TableHead className="text-right">未纳入</TableHead>
                  <TableHead className="text-right">失败</TableHead>
                  <TableHead>操作人</TableHead>
                  <TableHead className="w-10"><span className="sr-only">下载</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow key={b.batch_id}>
                    <TableCell className="text-xs whitespace-nowrap">{new Date(b.last_at).toLocaleString()}</TableCell>
                    <TableCell className="text-xs">{KIND_LABEL[b.kind] ?? b.kind}</TableCell>
                    <TableCell className="text-xs">
                      {b.source_advertiser_id
                        ? <AdvBc name={b.source_advertiser_name || advNames[b.source_advertiser_id ?? ""]} id={b.source_advertiser_id} bcName={b.source_bc_name} bcId={b.source_bc_id} />
                        : <span className="block max-w-48 truncate" title={b.source}>{b.source}</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      <AdvBc name={b.advertiser_name || advNames[b.advertiser_id]} id={b.advertiser_id} bcName={b.bc_name} bcId={b.bc_id} />
                    </TableCell>
                    <TableCell className="text-right text-xs">{b.groups}</TableCell>
                    <TableCell className="text-right text-xs text-emerald-600">{b.counts["成功"] ?? 0}</TableCell>
                    <TableCell className="text-right text-xs text-amber-600">{b.counts["组成功商品未纳入"] ?? 0}</TableCell>
                    <TableCell className="text-right text-xs text-destructive">{b.counts["失败"] ?? 0}</TableCell>
                    <TableCell className="text-xs">{b.operator}</TableCell>
                    <TableCell>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => download(b)} aria-label="下载商品明细">
                        <Download className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
