import * as React from "react";
import * as XLSX from "xlsx";
import { createFileRoute } from "@tanstack/react-router";
import { Play, Upload, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { useConnections, useBCAdvertisers } from "@/lib/store";

export const Route = createFileRoute("/gmv-max-create")({
  head: () => ({ meta: [{ title: "GMV MAX新建 - TikTok授权工具" }] }),
  component: GmvMaxCreatePage,
});

type ResultRow = {
  row: number;
  advertiser_id: string;
  campaign_name: string;
  ok: boolean;
  campaign_id?: string;
  error?: string;
};
type BatchRow = {
  advertiser_id: string;
  campaign_name: string;
  item_group_ids: string[];
  roas_bid: number;
  budget: number;
  start_time?: string;
  end_time?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
function defaultStartLocal(): string {
  const d = new Date(Date.now() + 5 * 60000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// <input type=datetime-local> gives "YYYY-MM-DDTHH:mm" -> TikTok wants "YYYY-MM-DD HH:MM:SS"
function toTikTokTime(dtLocal: string): string {
  if (!dtLocal) return "";
  return `${dtLocal.replace("T", " ")}:00`;
}
function splitIds(text: string): string[] {
  return text.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
}
// Accepts an Excel date serial number, a "YYYY-MM-DD HH:mm(:ss)" string, or blank.
function excelTimeToTikTok(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && isFinite(v) && v > 1 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return undefined;
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}:00`;
  }
  const s = String(v).trim();
  if (!s) return undefined;
  return `${s.replace("T", " ").slice(0, 16)}:00`;
}

async function runBatch(rows: BatchRow[]): Promise<ResultRow[]> {
  const data = await invokeFn<{ results: ResultRow[] }>("gmv-max-adgroup-batch-create", { rows });
  return data.results ?? [];
}

function ResultsTable({ results }: { results: ResultRow[] }) {
  if (!results.length) return null;
  const okCount = results.filter((r) => r.ok).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          结果 <span className="text-xs font-normal text-muted-foreground ml-1">（成功 {okCount} / 共 {results.length}）</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">#</TableHead>
                <TableHead className="w-44">广告户ID</TableHead>
                <TableHead>广告组名称</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead>Campaign ID / 错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={r.row}>
                  <TableCell className="text-xs text-muted-foreground">{r.row}</TableCell>
                  <TableCell className="font-mono text-xs">{r.advertiser_id}</TableCell>
                  <TableCell className="text-xs">{r.campaign_name}</TableCell>
                  <TableCell>
                    <span className={r.ok ? "text-emerald-600 text-xs font-medium" : "text-destructive text-xs font-medium"}>
                      {r.ok ? "成功" : "失败"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {r.ok ? r.campaign_id : <span className="text-destructive font-sans">{r.error}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function GmvMaxCreatePage() {
  const { connections, shops } = useConnections();
  const { advertisers } = useBCAdvertisers();

  const advOptions = React.useMemo(() => {
    const advNameById = new Map(advertisers.map((a) => [a.advertiser_id, a.advertiser_name]));
    const bcIdByAdv = new Map<string, string>();
    for (const c of connections) {
      if (!c.bc_id) continue;
      for (const id of c.advertiser_ids) if (!bcIdByAdv.has(id)) bcIdByAdv.set(id, c.bc_id);
    }
    const ids = Array.from(new Set(connections.flatMap((c) => c.advertiser_ids)));
    return ids
      .map((id) => ({
        id,
        name: advNameById.get(id) ?? id,
        shopId: shops[id]?.shop_id ?? null,
        bcId: bcIdByAdv.get(id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [connections, shops, advertisers]);

  // ---- 单个新建 ----
  const [advertiserId, setAdvertiserId] = React.useState("");
  const [campaignName, setCampaignName] = React.useState("");
  const [itemGroupIdsText, setItemGroupIdsText] = React.useState("");
  const [roasBid, setRoasBid] = React.useState("");
  const [budget, setBudget] = React.useState("");
  const [startTime, setStartTime] = React.useState(defaultStartLocal());
  const [endTime, setEndTime] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [results, setResults] = React.useState<ResultRow[]>([]);

  const selectedAdv = advOptions.find((a) => a.id === advertiserId);
  const advNotReady = !!advertiserId && selectedAdv && (!selectedAdv.shopId || !selectedAdv.bcId);

  const handleSubmit = async () => {
    if (!advertiserId) return toast.error("请选择广告户");
    if (!campaignName.trim()) return toast.error("请填写广告组名称");
    const itemGroupIds = splitIds(itemGroupIdsText);
    if (!itemGroupIds.length) return toast.error("请至少填写一个商品ID");
    const roas = Number(roasBid);
    const bud = Number(budget);
    if (!Number.isFinite(roas) || roas <= 0) return toast.error("ROI 必须是大于 0 的数字");
    if (!Number.isFinite(bud) || bud <= 0) return toast.error("预算必须是大于 0 的数字");

    setSubmitting(true);
    try {
      const row: BatchRow = {
        advertiser_id: advertiserId,
        campaign_name: campaignName.trim(),
        item_group_ids: itemGroupIds,
        roas_bid: roas,
        budget: bud,
        start_time: toTikTokTime(startTime),
        end_time: toTikTokTime(endTime),
      };
      const res = await runBatch([row]);
      setResults(res);
      const ok = res[0]?.ok;
      if (ok) toast.success(`创建成功，Campaign ID: ${res[0].campaign_id}`);
      else toast.error(`创建失败：${res[0]?.error ?? "未知错误"}`);
    } catch (e) {
      toast.error(`请求失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Excel 批量新建 ----
  const [parsedRows, setParsedRows] = React.useState<BatchRow[]>([]);
  const [parseErrors, setParseErrors] = React.useState<string[]>([]);
  const [fileName, setFileName] = React.useState("");
  const [batchSubmitting, setBatchSubmitting] = React.useState(false);

  const downloadTemplate = () => {
    const aoa = [
      ["广告户ID", "广告组名称", "商品ID", "ROI", "预算", "开始时间", "结束时间"],
      ["7672316437213757461", "示例广告组", "1731973887448024673,1731912594758796897", 3.2, 30, "", ""],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "GMV Max 新建");
    XLSX.writeFile(wb, "gmv-max-新建模板.xlsx");
  };

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setParsedRows([]);
    setParseErrors([]);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("找不到工作表");
      const grid = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
      const rows: BatchRow[] = [];
      const errors: string[] = [];
      grid.forEach((raw, idx) => {
        const get = (...keys: string[]) => {
          for (const k of Object.keys(raw)) {
            if (keys.includes(k.replace(/\s+/g, ""))) return raw[k];
          }
          return "";
        };
        const advertiser_id = String(get("广告户ID", "广告户", "advertiser_id") ?? "").trim();
        const campaign_name = String(get("广告组名称", "广告组", "campaign_name") ?? "").trim();
        const item_group_ids = splitIds(String(get("商品ID", "商品", "item_group_ids") ?? ""));
        const roas_bid = Number(get("ROI", "roas_bid", "roi"));
        const budget = Number(get("预算", "budget"));
        const startTimeVal = excelTimeToTikTok(get("开始时间", "start_time"));
        const endTimeVal = excelTimeToTikTok(get("结束时间", "end_time"));
        const rowNo = idx + 2; // header is row 1
        if (!advertiser_id && !campaign_name && !item_group_ids.length) return; // skip fully blank row
        if (!advertiser_id) errors.push(`第 ${rowNo} 行：广告户ID 为空`);
        if (!campaign_name) errors.push(`第 ${rowNo} 行：广告组名称为空`);
        if (!item_group_ids.length) errors.push(`第 ${rowNo} 行：商品ID 为空`);
        if (!Number.isFinite(roas_bid) || roas_bid <= 0) errors.push(`第 ${rowNo} 行：ROI 必须是大于 0 的数字`);
        if (!Number.isFinite(budget) || budget <= 0) errors.push(`第 ${rowNo} 行：预算必须是大于 0 的数字`);
        rows.push({
          advertiser_id, campaign_name, item_group_ids, roas_bid, budget,
          start_time: startTimeVal,
          end_time: endTimeVal,
        });
      });
      setParsedRows(rows);
      setParseErrors(errors);
      if (!rows.length) toast.error("Excel 里没有解析到有效行");
      else toast.success(`解析到 ${rows.length} 行`);
    } catch (e) {
      toast.error(`解析失败：${(e as Error).message}`);
    }
  };

  const handleBatchSubmit = async () => {
    if (!parsedRows.length) return;
    if (parseErrors.length) return toast.error("有校验未通过的行，请修正后重新上传");
    setBatchSubmitting(true);
    try {
      const res = await runBatch(parsedRows);
      setResults(res);
      const ok = res.filter((r) => r.ok).length;
      toast.success(`批量创建完成：成功 ${ok} / 共 ${res.length}`);
    } catch (e) {
      toast.error(`请求失败：${(e as Error).message}`);
    } finally {
      setBatchSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">GMV MAX新建</h2>
        <p className="text-sm text-muted-foreground mt-1">
          真实调用 TikTok 建单接口，会产生真实花费。广告类型/商品类型/出价类型/排期类型/商品视频类型均按固定默认值
          （商品卡 · 指定商品 · ROAS 最小化出价 · 自动挑选素材）。
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">单个新建</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 max-w-3xl">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">广告户</span>
              <Select value={advertiserId} onValueChange={setAdvertiserId}>
                <SelectTrigger><SelectValue placeholder="选择广告户" /></SelectTrigger>
                <SelectContent>
                  {advOptions.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}（{a.id}）{(!a.shopId || !a.bcId) ? " · 缺店铺/BC信息" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {advNotReady && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  该广告户缺少{!selectedAdv?.shopId ? "店铺ID" : ""}{!selectedAdv?.shopId && !selectedAdv?.bcId ? "、" : ""}{!selectedAdv?.bcId ? "BC ID" : ""}，请先去「设置」补齐
                </p>
              )}
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">广告组名称</span>
              <Input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="如 观察组3-R3.2" />
            </div>
            <div className="space-y-1 col-span-2">
              <span className="text-xs text-muted-foreground">商品ID（一行一个）</span>
              <Textarea value={itemGroupIdsText} onChange={(e) => setItemGroupIdsText(e.target.value)} className="min-h-20 font-mono text-xs" placeholder={"1731973887448024673\n1731912594758796897"} />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">ROI（roas_bid）</span>
              <Input type="number" step="0.1" min="0" value={roasBid} onChange={(e) => setRoasBid(e.target.value)} placeholder="如 3.2" />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">预算</span>
              <Input type="number" step="1" min="0" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="如 30" />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">开始时间（默认马上开始）</span>
              <Input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">结束时间（默认不设置）</span>
              <Input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>
          <Button onClick={handleSubmit} disabled={submitting}>
            <Play className="h-4 w-4 mr-1" />{submitting ? "创建中…" : "创建广告组"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Excel 批量新建</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            列：广告户ID / 广告组名称 / 商品ID（多个用逗号或换行分隔）/ ROI / 预算 / 开始时间（可空）/ 结束时间（可空）。设置逻辑同「单个新建」。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={downloadTemplate}><Download className="h-4 w-4 mr-1" />下载模板</Button>
            <Input
              type="file"
              accept=".xlsx,.xls"
              className="max-w-xs"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>
          {fileName && (
            <p className="text-xs text-muted-foreground">
              {fileName} · 解析到 {parsedRows.length} 行{parseErrors.length ? `，${parseErrors.length} 个校验问题` : ""}
            </p>
          )}
          {parseErrors.length > 0 && (
            <ul className="text-xs text-destructive space-y-0.5">
              {parseErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <Button onClick={handleBatchSubmit} disabled={!parsedRows.length || !!parseErrors.length || batchSubmitting}>
            <Upload className="h-4 w-4 mr-1" />{batchSubmitting ? "批量创建中…" : `批量创建（${parsedRows.length} 行）`}
          </Button>
        </CardContent>
      </Card>

      <ResultsTable results={results} />
    </div>
  );
}
