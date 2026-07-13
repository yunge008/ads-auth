// Excel 上传归因：多文件选择（文件名「站点 MAX yyyymm.xlsx」）→ 解析预览 → 分批上传 → 归因汇总。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FileUp, Trash2, Eye, RotateCw, Layers } from "lucide-react";
import { toast } from "sonner";
import { parseAdExcel, type ParsedFile } from "@/lib/adExcel";
import {
  type AttributionReport,
  type DetailRow,
  type DrillFilter,
  type UploadRec,
  currentMonth,
  fmtUsd,
  uploadApi,
} from "@/lib/attributionApi";
import { ProgressBoard } from "./ProgressBoard";
import { DetailTable } from "./DetailTable";

const BATCH = 1000;

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

type Viewing = { kind: "upload"; id: string; label: string } | { kind: "merged"; month: string };

export function UploadView() {
  const [files, setFiles] = React.useState<PendingFile[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [history, setHistory] = React.useState<UploadRec[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [mergeMonth, setMergeMonth] = React.useState(currentMonth());
  const [viewing, setViewing] = React.useState<Viewing | null>(null);
  const [summary, setSummary] = React.useState<AttributionReport | null>(null);
  const [detail, setDetail] = React.useState<{ rows: DetailRow[]; title: string } | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const loadHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await uploadApi.list();
      setHistory(r.uploads ?? []);
    } catch (e) {
      toast.error(`加载上传历史失败：${(e as Error).message}`);
    } finally {
      setHistoryLoading(false);
    }
  }, []);
  React.useEffect(() => { loadHistory(); }, [loadHistory]);

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
    try {
      for (const f of ready) {
        patchFile(f.id, { status: "uploading", progress: 2 });
        try {
          const { upload_id } = await uploadApi.create({
            file_name: f.file.name,
            country: f.country,
            month: f.month,
          });
          const rows = f.parsed!.rows;
          for (let i = 0; i < rows.length; i += BATCH) {
            await uploadApi.append(upload_id, rows.slice(i, i + BATCH));
            patchFile(f.id, { progress: Math.min(90, Math.round(((i + BATCH) / rows.length) * 85) + 2) });
          }
          patchFile(f.id, { progress: 92 });
          const fin = await uploadApi.finalize(upload_id);
          lastSummary = fin.summary;
          lastLabel = `${f.country} ${f.month}（${f.file.name}）`;
          patchFile(f.id, { status: "done", progress: 100 });
          setViewing({ kind: "upload", id: upload_id, label: lastLabel });
          toast.success(`${f.file.name}：${fin.row_count} 行归因完成`);
        } catch (e) {
          patchFile(f.id, { status: "failed", error: (e as Error).message });
          toast.error(`${f.file.name} 上传失败：${(e as Error).message}`);
        }
      }
      if (lastSummary) {
        setSummary(lastSummary);
        setDetail(null);
      }
      await loadHistory();
    } finally {
      setUploading(false);
    }
  };

  const viewUpload = async (u: UploadRec) => {
    setViewing({ kind: "upload", id: u.id, label: `${u.country} ${u.month}（${u.file_name}）` });
    setDetail(null);
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
    setDetail(null);
    setSummary(null);
    try {
      const r = await uploadApi.get({ month: mergeMonth, merged: true });
      setSummary(r.summary);
    } catch (e) {
      setViewing(null);
      toast.error((e as Error).message);
    }
  };

  const drill = async (f: DrillFilter) => {
    if (!viewing) return;
    setDetailLoading(true);
    const title = f.bucket ? (f.bucket === "PRODUCT_CARD" ? "商品卡明细" : "无建联明细") : `${f.staff} 明细`;
    setDetail({ rows: [], title });
    try {
      const r = viewing.kind === "upload"
        ? await uploadApi.get({ upload_id: viewing.id, detail_for: f })
        : await uploadApi.get({ month: viewing.month, merged: true, detail_for: f });
      setDetail({ rows: r.detail_rows ?? [], title });
    } catch (e) {
      toast.error(`加载明细失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
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
        setDetail(null);
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
                    <TableHead className="text-right">GMV</TableHead>
                    <TableHead className="text-right">商品卡行</TableHead>
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
                      <TableCell className="text-right tabular-nums">{f.parsed ? fmtUsd(f.parsed.totals.gmv) : "—"}</TableCell>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            上传历史 <span className="text-xs font-normal text-muted-foreground ml-1">最近 100 条</span>
          </CardTitle>
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" variant="outline" onClick={loadHistory} disabled={historyLoading}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${historyLoading ? "animate-spin" : ""}`} />刷新
            </Button>
            <div className="flex items-end gap-1.5">
              <Input type="month" value={mergeMonth} onChange={(e) => setMergeMonth(e.target.value)} className="h-8 w-40" />
              <Button size="sm" variant="outline" onClick={viewMerged}>
                <Layers className="h-4 w-4 mr-1.5" />按月合并查看
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead>站点</TableHead>
                  <TableHead>月份</TableHead>
                  <TableHead className="text-right">行数</TableHead>
                  <TableHead className="text-right">GMV</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>上传人/时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="h-16 text-center text-sm text-muted-foreground">暂无上传</TableCell></TableRow>
                ) : history.map((u) => (
                  <TableRow key={u.id}>
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
        </CardContent>
      </Card>

      {viewing && summary ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              归因结果：{viewing.kind === "upload" ? viewing.label : `${viewing.month} 全站点合并`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ProgressBoard report={summary} mode="admin" onDrill={drill} />
            {detail ? <DetailTable rows={detail.rows} loading={detailLoading} title={detail.title} /> : null}
          </CardContent>
        </Card>
      ) : viewing && !summary ? (
        <div className="text-sm text-muted-foreground text-center py-6">加载中…</div>
      ) : null}
    </div>
  );
}
