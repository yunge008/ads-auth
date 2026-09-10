// Excel 上传队列（模块级单例）。
//
// 为什么不放在组件 state 里：
//   1. 「Excel 上传」在 Radix Tabs 里，切到别的标签页 TabsContent 会卸载，组件 state 连同上传进度一起丢；
//   2. 10 万行的文件要跑几分钟，用户在这期间必然会去看别的标签页；
//   3. 组件卸载后 setState 无效，异步上传循环的进度就再也刷不出来。
// 所以队列状态和上传循环都放在这里，组件只通过 useSyncExternalStore 订阅快照。
// 另外把「可序列化的那部分」镜像进 sessionStorage，整页刷新后仍能看到上一轮的进度表（文件内容不可恢复，
// 这类条目标记 restored=true，只作展示）。
import type { CurrencyTotal, ParsedFile, ParsedRow } from "@/lib/adExcel";
import { parseAdExcel } from "@/lib/adExcel";
import { uploadApi, type AttributionReport } from "@/lib/attributionApi";

export type QueueStatus = "parsed" | "queued" | "uploading" | "finalizing" | "done" | "failed";

export type QueueItem = {
  id: string;
  fileName: string;
  country: string;
  month: string;
  status: QueueStatus;
  /** 当前阶段的中文说明，直接展示在进度列里 */
  phase: string;
  totalRows: number;
  uploadedRows: number;
  error?: string | null;
  parseError?: string | null;
  uploadId?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  /** 解析统计（展示用，刷新后仍保留） */
  stats: {
    rows: number;
    gmvRows: number;
    productCardRows: number;
    byCurrency: CurrencyTotal[];
  } | null;
  diagnostics: ParsedFile["diagnostics"] | null;
  /** true = 由 sessionStorage 恢复，行数据已不在内存，不能再上传 */
  restored?: boolean;
};

export type Viewing = { kind: "upload"; id: string; label: string } | { kind: "merged"; month: string };

export type QueueState = {
  items: QueueItem[];
  uploading: boolean;
  /** 归因结果（放在这里，切标签页回来不会被重置成 null） */
  viewing: Viewing | null;
  summary: AttributionReport | null;
};

const SS_KEY = "tt_ad_upload_queue_v1";

/** 单批行数。服务端 append 上限 2000，取满可把 10 万行的请求数从 100 降到 50。 */
const BATCH = 2000;
/** 并发批次数。串行 100 个请求容易被单次网络抖动整体拖垮，也慢。 */
const CONCURRENCY = 3;
/** 单批失败重试次数（指数退避），覆盖 502/504/网络瞬断 —— 以前一批失败整个文件就废了。 */
const RETRY = 3;

let state: QueueState = { items: [], uploading: false, viewing: null, summary: null };
/** 行数据只在内存里，不进 sessionStorage（10 万行放不下也没必要） */
const rowsById = new Map<string, ParsedRow[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    // 只存展示需要的字段；行数据和 File 对象都不存
    const items = state.items.map((i) => ({ ...i, restored: true }));
    window.sessionStorage.setItem(SS_KEY, JSON.stringify({ items }));
  } catch {
    /* 配额满/隐私模式：进度镜像不是关键路径，忽略 */
  }
}

function setState(next: Partial<QueueState>, opts?: { persist?: boolean }) {
  state = { ...state, ...next };
  if (opts?.persist !== false) persist();
  emit();
}

function patchItem(id: string, patch: Partial<QueueItem>, opts?: { persist?: boolean }) {
  setState({ items: state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }, opts);
}

/** 页面刷新后把上一轮的进度表读回来（只读展示）。 */
function restore() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(SS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { items?: QueueItem[] };
    const items = (parsed.items ?? []).map((i) => ({
      ...i,
      restored: true,
      // 刷新时还在上传中的条目：进程已经没了，标成失败而不是永远转圈
      status: i.status === "uploading" || i.status === "finalizing" || i.status === "queued" ? ("failed" as const) : i.status,
      phase:
        i.status === "uploading" || i.status === "finalizing" || i.status === "queued"
          ? "页面刷新导致上传中断，请重新选择文件上传"
          : i.phase,
    }));
    if (items.length) state = { ...state, items };
  } catch {
    /* 坏数据直接忽略 */
  }
}
restore();

export const uploadQueue = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  getSnapshot(): QueueState {
    return state;
  },
  getServerSnapshot(): QueueState {
    return state;
  },

  setResult(viewing: Viewing | null, summary: AttributionReport | null) {
    setState({ viewing, summary }, { persist: false });
  },

  clear() {
    rowsById.clear();
    setState({ items: [] });
  },

  patch(id: string, patch: Partial<QueueItem>) {
    patchItem(id, patch);
  },

  /** 解析并入队。解析失败的文件也会入队（status=failed），便于用户看到原因。 */
  async addFiles(list: FileList | File[], onWarn?: (msg: string) => void, onError?: (msg: string) => void) {
    const next: QueueItem[] = [];
    for (const f of Array.from(list)) {
      const id = `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const parsed = await parseAdExcel(f);
        rowsById.set(id, parsed.rows);
        next.push({
          id,
          fileName: f.name,
          country: parsed.country ?? "",
          month: parsed.month ?? "",
          status: "parsed",
          phase: "待上传",
          totalRows: parsed.rows.length,
          uploadedRows: 0,
          stats: {
            rows: parsed.totals.rows,
            gmvRows: parsed.totals.gmvRows,
            productCardRows: parsed.totals.productCardRows,
            byCurrency: parsed.totals.byCurrency,
          },
          diagnostics: parsed.diagnostics,
        });
        if (!parsed.country || !parsed.month) {
          onWarn?.(`${f.name}：文件名不符合「站点 MAX yyyymm.xlsx」，请手动填写站点/月份`);
        }
      } catch (e) {
        const msg = (e as Error).message;
        next.push({
          id,
          fileName: f.name,
          country: "",
          month: "",
          status: "failed",
          phase: "解析失败",
          totalRows: 0,
          uploadedRows: 0,
          parseError: msg,
          error: msg,
          stats: null,
          diagnostics: null,
        });
        onError?.(msg);
      }
    }
    setState({ items: [...state.items, ...next] });
  },

  /**
   * 依次上传队列里所有 status=parsed 的文件。
   * 调用方只负责给出提示回调；循环本身跑在模块作用域，组件卸载不影响它继续跑。
   */
  async run(cb: {
    onDuplicate: (msg: string) => boolean;
    onMissingRates: (currencies: string[]) => Promise<boolean>;
    onSuccess: (msg: string) => void;
    onError: (msg: string) => void;
    onWarn: (msg: string) => void;
    onFinished: () => void | Promise<void>;
  }) {
    if (state.uploading) return;
    const ready = state.items.filter((i) => i.status === "parsed" && !i.restored && rowsById.has(i.id));
    if (!ready.length) return;
    for (const it of ready) {
      if (!it.country || !/^\d{4}-\d{2}$/.test(it.month)) {
        cb.onError(`${it.fileName}：站点/月份未填写完整`);
        return;
      }
    }

    setState({ uploading: true, items: state.items.map((i) => (ready.some((r) => r.id === i.id) ? { ...i, status: "queued", phase: "排队中" } : i)) });

    let lastSummary: AttributionReport | null = null;
    let lastLabel = "";
    const completedMonths = new Set<string>();

    try {
      for (const item of ready) {
        const rows = rowsById.get(item.id) ?? [];
        patchItem(item.id, { status: "uploading", phase: "创建批次", uploadedRows: 0, startedAt: Date.now(), error: null });
        try {
          const uploadId = await createBatch(item, cb.onDuplicate);
          patchItem(item.id, { uploadId, phase: "上传数据" });

          await appendRows(uploadId, rows, (done) => {
            patchItem(item.id, { uploadedRows: done, phase: `上传数据 ${done.toLocaleString()} / ${rows.length.toLocaleString()} 行` });
          });

          patchItem(item.id, { status: "finalizing", uploadedRows: rows.length, phase: "服务端归因计算中（大文件需数分钟）" });
          const fin = await finalizeWithRates(uploadId, cb.onMissingRates);

          lastSummary = fin.summary;
          lastLabel = `${item.country} ${item.month}（${item.fileName}）`;
          completedMonths.add(item.month);
          patchItem(item.id, { status: "done", phase: "已归因", finishedAt: Date.now() });
          setState({ viewing: { kind: "upload", id: uploadId, label: lastLabel } }, { persist: false });
          cb.onSuccess(`${item.fileName}：${fin.row_count} 行归因完成`);
        } catch (e) {
          const msg = (e as Error).message;
          patchItem(item.id, { status: "failed", phase: "失败", error: msg, finishedAt: Date.now() });
          cb.onError(`${item.fileName} 上传失败：${msg}`);
        }
      }

      if (lastSummary) {
        const [month] = Array.from(completedMonths);
        if (completedMonths.size === 1 && month) {
          try {
            const merged = await uploadApi.get({ month, merged: true });
            setState({ viewing: { kind: "merged", month }, summary: merged.summary }, { persist: false });
            cb.onSuccess(`已展示 ${month} 全站点合并归因结果，请查看「归因结果」标签`);
          } catch (e) {
            setState({ summary: lastSummary }, { persist: false });
            cb.onWarn(`单文件归因已完成，但合并展示加载失败：${(e as Error).message}`);
          }
        } else {
          setState({ summary: lastSummary }, { persist: false });
        }
      }
      await cb.onFinished();
    } finally {
      setState({ uploading: false });
    }
  },
};

// ---------- 内部：单文件三步 ----------

async function createBatch(item: QueueItem, onDuplicate: (msg: string) => boolean): Promise<string> {
  try {
    const { upload_id } = await uploadApi.create({ file_name: item.fileName, country: item.country, month: item.month });
    return upload_id;
  } catch (e) {
    const payload = (e as Error & { payload?: { duplicate?: boolean } }).payload;
    if (!payload?.duplicate || !onDuplicate((e as Error).message)) throw e;
    const { upload_id } = await uploadApi.create({
      file_name: item.fileName,
      country: item.country,
      month: item.month,
      replace_existing: true,
    });
    return upload_id;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单批重试：append 以 (upload_id,row_no) 幂等 upsert，重发同一批安全。 */
async function appendChunk(uploadId: string, chunk: ParsedRow[]) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      await uploadApi.append(uploadId, chunk);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 有限并发地推送所有分批，每完成一批回报一次累计行数。 */
async function appendRows(uploadId: string, rows: ParsedRow[], onProgress: (done: number) => void) {
  const chunks: ParsedRow[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx];
      await appendChunk(uploadId, chunk);
      done += chunk.length;
      onProgress(Math.min(done, rows.length));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
}

async function finalizeWithRates(uploadId: string, onMissingRates: (c: string[]) => Promise<boolean>) {
  try {
    return await uploadApi.finalize(uploadId);
  } catch (e) {
    const payload = (e as Error & { payload?: { missing_currencies?: string[] } }).payload;
    if (!payload?.missing_currencies?.length || !(await onMissingRates(payload.missing_currencies))) throw e;
    return await uploadApi.finalize(uploadId);
  }
}

/** 进度百分比：上传占 0-90，归因占 90-100。 */
export function itemPercent(i: QueueItem): number {
  if (i.status === "done") return 100;
  if (i.status === "finalizing") return 95;
  if (i.status === "failed") return i.totalRows ? Math.round((i.uploadedRows / i.totalRows) * 90) : 0;
  if (i.status !== "uploading") return 0;
  if (!i.totalRows) return 2;
  return Math.max(2, Math.min(90, Math.round((i.uploadedRows / i.totalRows) * 90)));
}
