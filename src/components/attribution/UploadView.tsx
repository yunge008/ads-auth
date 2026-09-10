// Excel 上传归因：多文件选择（文件名「站点 MAX yyyymm.xlsx」）→ 解析预览 → 分批上传 → 归因汇总。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileUp, Trash2, Eye, RotateCw, Layers, ChevronLeft, ChevronRight, Eraser, CheckSquare, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { MultiSelect } from "@/components/MultiSelect";
import {
  type AttributionReport,
  type UploadRec,
  lastMonth,
  exchangeRateApi,
  fmtUsd,
  uploadApi,
} from "@/lib/attributionApi";
import { uploadQueue, itemPercent, type Viewing } from "@/lib/uploadQueue";
import { UploadStatusMatrix } from "./UploadStatusMatrix";


const HISTORY_PAGE_SIZE = 20;
const STALE_MINUTES = 15;

/** 逐个币种要求用户填「1 美元 = 多少本币」并落库；用户取消或输入无效返回 false。 */
async function promptMissingRates(missing: string[]): Promise<boolean> {
  for (const cur of missing) {
    const input = window.prompt(`缺少汇率：请输入 1 美元 = 多少 ${cur}？（例如泰铢填 33）`);
    if (input == null) return false;
    const rate = Number(input);
    if (!isFinite(rate) || rate <= 0) {
      toast.error(`${cur} 汇率输入无效`);
      return false;
    }
    await exchangeRateApi.save({ currency: cur, usd_rate: rate, enabled: true });
  }
  return true;
}

export type { Viewing };

export function UploadView({
  onResult,
}: {
  onResult?: (r: { viewing: Viewing; summary: AttributionReport } | null) => void;
}) {
  // 队列状态放在模块级 store 里：切到别的标签页 TabsContent 会卸载本组件，
  // 组件 state 会连同上传进度一起丢，而 10 万行的文件上传要跑好几分钟。
  const queue = React.useSyncExternalStore(uploadQueue.subscribe, uploadQueue.getSnapshot, uploadQueue.getServerSnapshot);
  const files = queue.items;
  const uploading = queue.uploading;
  const viewing = queue.viewing;
  const summary = queue.summary;
  const [history, setHistory] = React.useState<UploadRec[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [mergeMonth, setMergeMonth] = React.useState(lastMonth());
  const [selectedCountries, setSelectedCountries] = React.useState<string[]>([]);
  const [refinalizing, setRefinalizing] = React.useState<string | null>(null);
  const [historyPage, setHistoryPage] = React.useState(1);
  const [clearing, setClearing] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [deleting, setDeleting] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const onResultRef = React.useRef(onResult);
  onResultRef.current = onResult;
  React.useEffect(() => {
    onResultRef.current?.(viewing && summary ? { viewing, summary } : null);
  }, [viewing, summary]);


  const loadHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await uploadApi.list();
      setHistory(r.uploads ?? []);
      setHistoryPage(1);
    } catch (e) {
      toast.error(`加载上传历史失败：${(e as Error).message}`);
    } finally {
      setHistoryLoading(false);
    }
  }, []);
  React.useEffect(() => { loadHistory(); }, [loadHistory]);

  const countryOptions = React.useMemo(() => {
    const set = new Set<string>();
    history.forEach((u) => { if (u.country) set.add(u.country); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [history]);
  const countryCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    history.forEach((u) => { if (u.country) counts[u.country] = (counts[u.country] || 0) + 1; });
    return counts;
  }, [history]);
  const filteredHistory = React.useMemo(() => {
    let list = history;
    if (/^\d{4}-\d{2}$/.test(mergeMonth)) list = list.filter((u) => u.month === mergeMonth);
    if (selectedCountries.length) list = list.filter((u) => selectedCountries.includes(u.country));
    return list;
  }, [history, mergeMonth, selectedCountries]);
  const historyPageCount = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
  const pagedHistory = filteredHistory.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);
  React.useEffect(() => { setHistoryPage(1); }, [mergeMonth, selectedCountries]);

  // 选中集合始终只保留仍在当前筛选结果里的批次，避免「删除选中」误删被筛掉的记录
  const visibleIds = React.useMemo(() => new Set(filteredHistory.map((u) => u.id)), [filteredHistory]);
  const selectedIds = React.useMemo(() => Array.from(selected).filter((id) => visibleIds.has(id)), [selected, visibleIds]);
  const allFilteredSelected = filteredHistory.length > 0 && selectedIds.length === filteredHistory.length;
  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  /** 全选=当前筛选下的全部批次（跨页），不是只选当前这一页。 */
  const toggleAllFiltered = (on: boolean) =>
    setSelected(on ? new Set(filteredHistory.map((u) => u.id)) : new Set());


  const onPickFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    await uploadQueue.addFiles(list, (m) => toast.warning(m), (m) => toast.error(m));
    if (fileInput.current) fileInput.current.value = "";
  };

  const patchFile = uploadQueue.patch;

  // 会让 GMV 静默算错的三种情况，解析阶段就摊开说清楚，别等归因完了再猜
  const parseWarnings = React.useMemo(() => {
    const out: string[] = [];
    for (const f of files) {
      const d = f.diagnostics;
      if (!d || !f.stats) continue;
      const n = f.fileName;
      if (d.blankCurrencyRows) {
        out.push(`${n}：有 ${d.blankCurrencyRows} 行的「货币」单元格是空的，这些行会按 USD 计算。若实际是泰铢，GMV 会被放大约 32.5 倍。`);
      }
      if (d.unexpectedCurrencies.length) {
        out.push(`${n}：出现了预期外的币种 ${d.unexpectedCurrencies.join("、")}（目前业务上只应有 USD / THB）。请先在「设置 → GMV 归因汇率」维护这些币种的汇率，否则这部分数据不会计入归因。`);
      }
      if (d.badNumberCells) {
        out.push(`${n}：有 ${d.badNumberCells} 个金额单元格解析不出数字（样本：${d.badNumberSamples.join(" / ")}），这些行的成本/GMV 记为 0。`);
      }
      if (f.stats.byCurrency.length > 1) {
        out.push(`${n}：文件里存在多个币种（${f.stats.byCurrency.map((c) => `${c.currency} ${c.rows} 行`).join("、")}），请确认每个币种都已在设置页维护汇率。`);
      }
      if (f.stats.rows > 0 && f.stats.gmvRows === 0) {
        out.push(`${n}：${f.stats.rows} 行里没有任何一行 GMV 非 0，「总收入 / Gross revenue」列很可能取错或为空。未识别的表头：${d.unmappedHeaders.join("、") || "无"}。`);
      }
    }
    return out;
  }, [files]);

  const uploadAll = () =>
    uploadQueue.run({
      onDuplicate: (msg) => window.confirm(`${msg}\n\n是否替换旧记录？`),
      onMissingRates: promptMissingRates,
      onSuccess: (m) => toast.success(m),
      onError: (m) => toast.error(m),
      onWarn: (m) => toast.warning(m),
      onFinished: loadHistory,
    });

  /** 批次行数已经传完但卡在 UPLOADING（多半是上一轮归并超时），重跑一次归并即可，不必重传文件。 */
  const refinalize = async (u: UploadRec) => {
    setRefinalizing(u.id);
    try {
      const fin = await uploadApi.finalize(u.id);
      uploadQueue.setResult({ kind: "upload", id: u.id, label: `${u.country} ${u.month}（${u.file_name}）` }, fin.summary);
      toast.success(`${u.file_name}：${fin.row_count} 行已归并${fin.agg_rows ? `为 ${fin.agg_rows} 组` : ""}`);
      await loadHistory();
    } catch (e) {
      const payload = (e as Error & { payload?: { missing_currencies?: string[] } }).payload;
      if (payload?.missing_currencies?.length && (await promptMissingRates(payload.missing_currencies))) {
        setRefinalizing(null);
        return refinalize(u);
      }
      toast.error(`重新归并失败：${(e as Error).message}`);
    } finally {
      setRefinalizing(null);
    }
  };

  const viewUpload = async (u: UploadRec) => {
    uploadQueue.setResult({ kind: "upload", id: u.id, label: `${u.country} ${u.month}（${u.file_name}）` }, null);
    try {
      const r = await uploadApi.get({ upload_id: u.id });
      uploadQueue.setResult({ kind: "upload", id: u.id, label: `${u.country} ${u.month}（${u.file_name}）` }, r.summary);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    }
  };

  const viewMerged = async () => {
    if (!/^\d{4}-\d{2}$/.test(mergeMonth)) return;
    uploadQueue.setResult({ kind: "merged", month: mergeMonth }, null);
    try {
      const r = await uploadApi.get({ month: mergeMonth, merged: true });
      uploadQueue.setResult({ kind: "merged", month: mergeMonth }, r.summary);
    } catch (e) {
      uploadQueue.setResult(null, null);
      toast.error((e as Error).message);
    }
  };


  // 卡死判定：状态非「已归因」且创建时间超过 STALE_MINUTES 分钟
  const staleUploads = React.useMemo(
    () =>
      history.filter(
        (u) => u.status !== "READY" && Date.now() - new Date(u.created_at).getTime() > STALE_MINUTES * 60_000,
      ),
    [history],
  );

  const clearStale = async () => {
    if (!staleUploads.length) return;
    const list = staleUploads.slice(0, 10).map((u) => `· ${u.country} ${u.month} ${u.file_name}`).join("\n");
    if (!window.confirm(
      `将清除 ${staleUploads.length} 条卡住/失败的上传记录（超过 ${STALE_MINUTES} 分钟仍未完成），清除后可重新上传：\n\n${list}${staleUploads.length > 10 ? "\n…" : ""}`,
    )) return;
    setClearing(true);
    let ok = 0;
    let fail = 0;
    for (const u of staleUploads) {
      try {
        await uploadApi.remove(u.id);
        ok++;
      } catch {
        fail++;
      }
    }
    setClearing(false);
    if (ok) toast.success(`已清除 ${ok} 条卡住的上传记录`);
    if (fail) toast.error(`${fail} 条清除失败，请重试`);
    await loadHistory();
  };

  const removeSelected = async () => {
    if (!selectedIds.length) return;
    const preview = filteredHistory
      .filter((u) => selectedIds.includes(u.id))
      .slice(0, 10)
      .map((u) => `· ${u.country} ${u.month} ${u.file_name}`)
      .join("\n");
    if (!window.confirm(
      `确认删除选中的 ${selectedIds.length} 个上传批次？连同批次内的所有数据行一并删除，不可恢复：\n\n${preview}${selectedIds.length > 10 ? "\n…" : ""}`,
    )) return;
    setDeleting(true);
    try {
      const { deleted } = await uploadApi.removeMany(selectedIds);
      toast.success(`已删除 ${deleted} 个批次`);
      if (viewing?.kind === "upload" && selectedIds.includes(viewing.id)) {
        uploadQueue.setResult(null, null);
      }
      setSelected(new Set());
      await loadHistory();
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  /** 跨页、跨筛选清空全部上传批次。二次确认 + 输入校验，避免误点。 */
  const removeAll = async () => {
    if (!history.length) return;
    if (!window.confirm(`确认清空全部 ${history.length} 个上传批次（含被筛选隐藏的）？连同所有数据行一并删除，不可恢复。`)) return;
    if (window.prompt(`这一步会删掉全部 ${history.length} 个批次的所有数据。确认请输入「全部删除」：`) !== "全部删除") {
      toast.info("已取消");
      return;
    }
    setDeleting(true);
    try {
      const { deleted } = await uploadApi.removeAll();
      toast.success(`已清空 ${deleted} 个批次`);
      uploadQueue.setResult(null, null);
      setSelected(new Set());
      await loadHistory();
    } catch (e) {
      toast.error(`清空失败：${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  const removeUpload = async (u: UploadRec) => {
    if (!window.confirm(`确认删除上传批次「${u.file_name}」（${u.row_count} 行）？`)) return;
    try {
      await uploadApi.remove(u.id);
      toast.success("已删除");
      if (viewing?.kind === "upload" && viewing.id === u.id) {
        uploadQueue.setResult(null, null);
      }
      await loadHistory();
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">上传广告表</CardTitle>
          <p className="text-xs text-muted-foreground">
            支持多选，文件名需为「站点 MAX yyyymm.xlsx」，站点用英文简写（如 PH MAX 202607.xlsx、MX-AR MAX 202607.xlsx）；中英文表头均可。同月多站点上传后可在下方按月合并查看。
            <br />大文件（10 万行级）会分批并发上传，进度列实时显示已传行数与阶段；切到别的标签页再回来进度不会丢。
            <br />上传只负责存数据并按「VID + 达人昵称」归并；<b>归因不在这一步计算</b>，而是每次出报表时按当下的飞书登记数据现算，所以同步达人登记后不需要重传。
            <br />下表「行数」「商品卡行数」「有GMV行数」是 Excel 原始行计数；「GMV（原币种）」按文件里「货币」列分组汇总、仍是文件自身币种，上传归因后才按汇率折美元。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="hidden"
              onChange={(e) => onPickFiles(e.target.files)}
            />
            <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading}>
              <FileUp className="h-4 w-4 mr-1.5" />选择文件（可多选）
            </Button>
            <Button size="sm" onClick={uploadAll} disabled={uploading || !files.some((f) => f.status === "parsed" && !f.restored)}>
              {uploading ? <RotateCw className="h-4 w-4 mr-1.5 animate-spin" /> : null}上传并归因
            </Button>
            {files.length ? (
              <Button size="sm" variant="ghost" onClick={() => uploadQueue.clear()} disabled={uploading}>清空列表</Button>
            ) : null}
          </div>

          {files.length ? (
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>文件</TableHead>
                    <TableHead>站点</TableHead>
                    <TableHead>月份</TableHead>
                    <TableHead className="text-right">行数</TableHead>
                    <TableHead className="text-right">GMV（原币种）</TableHead>
                    <TableHead className="text-right">有GMV行数</TableHead>
                    <TableHead className="text-right">商品卡行数</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-64">进度</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="text-xs max-w-64 truncate" title={f.fileName}>{f.fileName}</TableCell>
                      <TableCell>
                        <Input value={f.country} onChange={(e) => patchFile(f.id, { country: e.target.value })} className="h-7 w-24" disabled={f.status !== "parsed"} />
                      </TableCell>
                      <TableCell>
                        <Input type="month" value={f.month} onChange={(e) => patchFile(f.id, { month: e.target.value })} className="h-7 w-36" disabled={f.status !== "parsed"} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.stats?.rows ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.stats
                          ? f.stats.byCurrency.map((c) => (
                              <div key={c.currency} className="whitespace-nowrap">
                                <span className="text-muted-foreground mr-1">{c.currency}</span>{fmtUsd(c.gmv)}
                              </div>
                            ))
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.stats ? `${f.stats.gmvRows} / ${f.stats.rows}` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.stats?.productCardRows ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {f.status === "parsed" ? <Badge variant="secondary">待上传</Badge>
                          : f.status === "queued" ? <Badge variant="secondary">排队中</Badge>
                          : f.status === "uploading" ? <Badge variant="secondary">上传中</Badge>
                          : f.status === "finalizing" ? <Badge variant="secondary">归因中</Badge>
                          : f.status === "done" ? <Badge>完成</Badge>
                          : <span className="text-destructive" title={f.error ?? f.parseError ?? ""}>失败</span>}
                        {f.restored ? <div className="text-[11px] text-muted-foreground">刷新前的记录</div> : null}
                      </TableCell>
                      {/* 进度列：百分比 + 已传行数 / 总行数 + 当前阶段。大文件要跑几分钟，没有这列用户只能盯着「上传中」猜。 */}
                      <TableCell className="text-xs">
                        {f.status === "parsed" ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="space-y-1 w-60">
                            <div className="flex items-center gap-2">
                              <Progress value={itemPercent(f)} className="flex-1" />
                              <span className="tabular-nums w-10 text-right">{itemPercent(f)}%</span>
                            </div>
                            <div className="text-muted-foreground tabular-nums">
                              {f.totalRows
                                ? `${f.uploadedRows.toLocaleString()} / ${f.totalRows.toLocaleString()} 行`
                                : ""}
                            </div>
                            <div className={f.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                              {f.status === "failed" ? (f.error ?? f.parseError ?? f.phase) : f.phase}
                            </div>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {parseWarnings.length ? (
            <div className="text-xs rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 space-y-1">
              {parseWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            上传历史 <span className="text-xs font-normal text-muted-foreground ml-1">共 {filteredHistory.length} 条</span>
          </CardTitle>
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" variant="outline" onClick={loadHistory} disabled={historyLoading}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${historyLoading ? "animate-spin" : ""}`} />刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={clearStale}
              disabled={clearing || historyLoading || !staleUploads.length}
            >
              <Eraser className={`h-4 w-4 mr-1.5 ${clearing ? "animate-pulse" : ""}`} />
              一键清除卡住记录{staleUploads.length ? `（${staleUploads.length}）` : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => toggleAllFiltered(!allFilteredSelected)}
              disabled={historyLoading || !filteredHistory.length}
              title="全选/取消全选当前筛选下的全部批次（跨页）"
            >
              <CheckSquare className="h-4 w-4 mr-1.5" />
              {allFilteredSelected ? "取消全选" : `全选当前筛选（${filteredHistory.length}）`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={removeSelected}
              disabled={deleting || !selectedIds.length}
            >
              <Trash2 className={`h-4 w-4 mr-1.5 ${deleting ? "animate-pulse" : ""}`} />
              删除选中（{selectedIds.length}）
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={removeAll}
              disabled={deleting || historyLoading || !history.length}
              title="删除全部上传批次，含被筛选隐藏的"
            >
              <Trash2 className="h-4 w-4 mr-1.5" />全部删除（{history.length}）
            </Button>
            <div className="flex flex-wrap items-end gap-1.5">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">筛选月份</span>
                <Input type="month" value={mergeMonth} onChange={(e) => setMergeMonth(e.target.value)} className="h-8 w-40" />
              </div>
              <MultiSelect
                label="站点"
                placeholder="全部站点"
                options={countryOptions}
                value={selectedCountries}
                onChange={setSelectedCountries}
                counts={countryCounts}
                className="min-w-[150px]"
              />
              <Button size="sm" variant="ghost" onClick={() => { setMergeMonth(""); setSelectedCountries([]); }}>显示全部</Button>
              <Button size="sm" variant="outline" onClick={viewMerged} disabled={!/^\d{4}-\d{2}$/.test(mergeMonth)}>
                <Layers className="h-4 w-4 mr-1.5" />按月合并查看
              </Button>
            </div>

          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="list">
            <TabsList>
              <TabsTrigger value="list">列表</TabsTrigger>
              <TabsTrigger value="matrix">上传状态矩阵</TabsTrigger>
            </TabsList>
            <TabsContent value="list" className="mt-3 space-y-2">
              <div className="border rounded-md overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allFilteredSelected}
                          onCheckedChange={(v) => toggleAllFiltered(v === true)}
                          disabled={!filteredHistory.length}
                          aria-label="全选当前筛选"
                        />
                      </TableHead>
                      <TableHead>文件</TableHead>
                      <TableHead>站点</TableHead>
                      <TableHead>月份</TableHead>
                      <TableHead className="text-right">行数</TableHead>
                      <TableHead className="text-right">GMV（USD）</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>上传人/时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHistory.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="h-16 text-center text-sm text-muted-foreground">暂无上传</TableCell></TableRow>
                    ) : pagedHistory.map((u) => (
                      <TableRow key={u.id} data-state={selected.has(u.id) ? "selected" : undefined}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(u.id)}
                            onCheckedChange={(v) => toggleOne(u.id, v === true)}
                            aria-label={`选择 ${u.file_name}`}
                          />
                        </TableCell>
                        <TableCell className="text-xs max-w-56 truncate" title={u.file_name}>{u.file_name}</TableCell>
                        <TableCell className="text-xs">{u.country}</TableCell>
                        <TableCell className="text-xs tabular-nums">{u.month}</TableCell>
                        <TableCell className="text-right tabular-nums">{u.row_count}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtUsd(u.total_revenue)}</TableCell>
                        <TableCell>
                          <Badge variant={u.status === "READY" ? "default" : u.status === "FAILED" ? "destructive" : "secondary"}>
                            {u.status === "READY" ? "已归因" : u.status === "FAILED" ? "失败" : "上传中"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{u.uploaded_by || "—"} · {new Date(u.created_at).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => viewUpload(u)} disabled={u.status !== "READY"}>
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            {u.status !== "READY" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                title="行数据已经传完、只是没归并完时，点这里重跑，不用重传文件"
                                onClick={() => refinalize(u)}
                                disabled={refinalizing === u.id}
                              >
                                <PlayCircle className={`h-3.5 w-3.5 ${refinalizing === u.id ? "animate-pulse" : ""}`} />
                              </Button>
                            ) : null}
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => removeUpload(u)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {history.length > HISTORY_PAGE_SIZE && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div>
                    第 {(historyPage - 1) * HISTORY_PAGE_SIZE + 1}-{Math.min(historyPage * HISTORY_PAGE_SIZE, filteredHistory.length)} / 共 {filteredHistory.length} 条
                    {selectedIds.length ? ` · 已选 ${selectedIds.length} 条（跨页）` : ""}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="h-7" disabled={historyPage <= 1} onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <span>{historyPage} / {historyPageCount}</span>
                    <Button size="sm" variant="outline" className="h-7" disabled={historyPage >= historyPageCount} onClick={() => setHistoryPage((p) => Math.min(historyPageCount, p + 1))}>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="matrix" className="mt-3">
              <UploadStatusMatrix history={history} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

    </div>
  );
}
