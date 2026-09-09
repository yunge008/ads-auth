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
import { FileUp, Trash2, Eye, RotateCw, Layers, ChevronLeft, ChevronRight, Eraser, CheckSquare } from "lucide-react";
import { toast } from "sonner";
import { MultiSelect } from "@/components/MultiSelect";
import { parseAdExcel, type ParsedFile } from "@/lib/adExcel";
import {
  type AttributionReport,
  type UploadRec,
  lastMonth,
  exchangeRateApi,
  fmtUsd,
  uploadApi,
} from "@/lib/attributionApi";
import { UploadStatusMatrix } from "./UploadStatusMatrix";


const BATCH = 1000;
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

type PendingFile = {
  id: string;
  file: File;
  parsed: ParsedFile | null;
  parseError: string | null;
  country: string;
  month: string;
  status: "parsed" | "uploading" | "done" | "failed";
  progress: number; // 0..100
  error?: string;
};

export type Viewing = { kind: "upload"; id: string; label: string } | { kind: "merged"; month: string };

export function UploadView({
  onResult,
}: {
  onResult?: (r: { viewing: Viewing; summary: AttributionReport } | null) => void;
}) {
  const [files, setFiles] = React.useState<PendingFile[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [history, setHistory] = React.useState<UploadRec[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [mergeMonth, setMergeMonth] = React.useState(lastMonth());
  const [selectedCountries, setSelectedCountries] = React.useState<string[]>([]);
  const [viewing, setViewing] = React.useState<Viewing | null>(null);
  const [summary, setSummary] = React.useState<AttributionReport | null>(null);
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
    const next: PendingFile[] = [];
    for (const f of Array.from(list)) {
      const id = `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const parsed = await parseAdExcel(f);
        next.push({
          id, file: f, parsed, parseError: null,
          country: parsed.country ?? "",
          month: parsed.month ?? "",
          status: "parsed", progress: 0,
        });
        if (!parsed.country || !parsed.month) {
          toast.warning(`${f.name}：文件名不符合「站点 MAX yyyymm.xlsx」，请手动填写站点/月份`);
        }
      } catch (e) {
        next.push({ id, file: f, parsed: null, parseError: (e as Error).message, country: "", month: "", status: "failed", progress: 0 });
        toast.error((e as Error).message);
      }
    }
    setFiles((prev) => [...prev, ...next]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const patchFile = (id: string, patch: Partial<PendingFile>) =>
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  // 会让 GMV 静默算错的三种情况，解析阶段就摊开说清楚，别等归因完了再猜
  const parseWarnings = React.useMemo(() => {
    const out: string[] = [];
    for (const f of files) {
      const d = f.parsed?.diagnostics;
      if (!d) continue;
      const n = f.file.name;
      if (d.blankCurrencyRows) {
        out.push(`${n}：有 ${d.blankCurrencyRows} 行的「货币」单元格是空的，这些行会按 USD 计算。若实际是泰铢，GMV 会被放大约 32.5 倍。`);
      }
      if (d.unexpectedCurrencies.length) {
        out.push(`${n}：出现了预期外的币种 ${d.unexpectedCurrencies.join("、")}（目前业务上只应有 USD / THB）。请先在「设置 → GMV 归因汇率」维护这些币种的汇率，否则这部分数据不会计入归因。`);
      }
      if (d.badNumberCells) {
        out.push(`${n}：有 ${d.badNumberCells} 个金额单元格解析不出数字（样本：${d.badNumberSamples.join(" / ")}），这些行的成本/GMV 记为 0。`);
      }
      if (f.parsed && f.parsed.totals.byCurrency.length > 1) {
        out.push(`${n}：文件里存在多个币种（${f.parsed.totals.byCurrency.map((c) => `${c.currency} ${c.rows} 行`).join("、")}），请确认每个币种都已在设置页维护汇率。`);
      }
      if (f.parsed && f.parsed.totals.rows > 0 && f.parsed.totals.gmvRows === 0) {
        out.push(`${n}：${f.parsed.totals.rows} 行里没有任何一行 GMV 非 0，「总收入 / Gross revenue」列很可能取错或为空。未识别的表头：${d.unmappedHeaders.join("、") || "无"}。`);
      }
    }
    return out;
  }, [files]);

  const uploadAll = async () => {
    const ready = files.filter((f) => f.status === "parsed" && f.parsed);
    if (!ready.length) return;
    for (const f of ready) {
      if (!f.country || !/^\d{4}-\d{2}$/.test(f.month)) {
        toast.error(`${f.file.name}：站点/月份未填写完整`);
        return;
      }
    }
    setUploading(true);
    let lastSummary: AttributionReport | null = null;
    let lastLabel = "";
    const completedMonths = new Set<string>();
    try {
      for (const f of ready) {
        patchFile(f.id, { status: "uploading", progress: 2 });
        try {
          let upload_id: string;
          try {
            ({ upload_id } = await uploadApi.create({ file_name: f.file.name, country: f.country, month: f.month }));
          } catch (e) {
            const payload = (e as Error & { payload?: { duplicate?: boolean } }).payload;
            if (!payload?.duplicate || !window.confirm(`${(e as Error).message}\n\n是否替换旧记录？`)) throw e;
            ({ upload_id } = await uploadApi.create({
              file_name: f.file.name, country: f.country, month: f.month, replace_existing: true,
            }));
          }
          const rows = f.parsed!.rows;
          for (let i = 0; i < rows.length; i += BATCH) {
            await uploadApi.append(upload_id, rows.slice(i, i + BATCH));
            patchFile(f.id, { progress: Math.min(90, Math.round(((i + BATCH) / rows.length) * 85) + 2) });
          }
          patchFile(f.id, { progress: 92 });
          let fin: Awaited<ReturnType<typeof uploadApi.finalize>>;
          try {
            fin = await uploadApi.finalize(upload_id);
          } catch (e) {
            const payload = (e as Error & { payload?: { missing_currencies?: string[] } }).payload;
            if (!payload?.missing_currencies?.length || !(await promptMissingRates(payload.missing_currencies))) throw e;
            fin = await uploadApi.finalize(upload_id);
          }
          lastSummary = fin.summary;
          lastLabel = `${f.country} ${f.month}（${f.file.name}）`;
          completedMonths.add(f.month);
          patchFile(f.id, { status: "done", progress: 100 });
          setViewing({ kind: "upload", id: upload_id, label: lastLabel });
          toast.success(`${f.file.name}：${fin.row_count} 行归因完成`);
        } catch (e) {
          patchFile(f.id, { status: "failed", error: (e as Error).message });
          toast.error(`${f.file.name} 上传失败：${(e as Error).message}`);
        }
      }
      if (lastSummary) {
        const [month] = Array.from(completedMonths);
        if (completedMonths.size === 1 && month) {
          try {
            const merged = await uploadApi.get({ month, merged: true });
            setViewing({ kind: "merged", month });
            setSummary(merged.summary);
            toast.success(`已展示 ${month} 全站点合并归因结果，请查看「归因结果」标签`);
          } catch (e) {
            setSummary(lastSummary);
            toast.warning(`单文件归因已完成，但合并展示加载失败：${(e as Error).message}`);
          }
        } else {
          setSummary(lastSummary);
        }
      }
      await loadHistory();
    } finally {
      setUploading(false);
    }
  };

  const viewUpload = async (u: UploadRec) => {
    setViewing({ kind: "upload", id: u.id, label: `${u.country} ${u.month}（${u.file_name}）` });
    setSummary(null);
    try {
      const r = await uploadApi.get({ upload_id: u.id });
      setSummary(r.summary);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    }
  };

  const viewMerged = async () => {
    if (!/^\d{4}-\d{2}$/.test(mergeMonth)) return;
    setViewing({ kind: "merged", month: mergeMonth });
    setSummary(null);
    try {
      const r = await uploadApi.get({ month: mergeMonth, merged: true });
      setSummary(r.summary);
    } catch (e) {
      setViewing(null);
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
        setViewing(null);
        setSummary(null);
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
      setViewing(null);
      setSummary(null);
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
        setViewing(null);
        setSummary(null);

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
            支持多选，文件名需为「站点 MAX yyyymm.xlsx」（如 墨西哥 MAX 202607.xlsx）；中英文表头均可。同月多站点上传后可在下方按月合并查看。
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
            <Button size="sm" onClick={uploadAll} disabled={uploading || !files.some((f) => f.status === "parsed")}>
              {uploading ? <RotateCw className="h-4 w-4 mr-1.5 animate-spin" /> : null}上传并归因
            </Button>
            {files.length ? (
              <Button size="sm" variant="ghost" onClick={() => setFiles([])} disabled={uploading}>清空列表</Button>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="text-xs max-w-64 truncate" title={f.file.name}>{f.file.name}</TableCell>
                      <TableCell>
                        <Input value={f.country} onChange={(e) => patchFile(f.id, { country: e.target.value })} className="h-7 w-24" disabled={f.status !== "parsed"} />
                      </TableCell>
                      <TableCell>
                        <Input type="month" value={f.month} onChange={(e) => patchFile(f.id, { month: e.target.value })} className="h-7 w-36" disabled={f.status !== "parsed"} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.parsed?.totals.rows ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.parsed
                          ? f.parsed.totals.byCurrency.map((c) => (
                              <div key={c.currency} className="whitespace-nowrap">
                                <span className="text-muted-foreground mr-1">{c.currency}</span>{fmtUsd(c.gmv)}
                              </div>
                            ))
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.parsed ? `${f.parsed.totals.gmvRows} / ${f.parsed.totals.rows}` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.parsed?.totals.productCardRows ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {f.status === "parsed" ? <Badge variant="secondary">待上传</Badge>
                          : f.status === "uploading" ? <div className="w-24"><Progress value={f.progress} /></div>
                          : f.status === "done" ? <Badge>完成</Badge>
                          : <span className="text-destructive" title={f.error ?? f.parseError ?? ""}>失败</span>}
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
