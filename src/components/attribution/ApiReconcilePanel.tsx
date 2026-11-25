// 接口对账：按 站点×月 从 TikTok 接口抓 GMV MAX 素材数据，与已上传的表逐项比（docs/AUTO_DATA_PLAN.md 第二节）。
// 只在打开这个 TAB 并点按钮时才跑；数据写进独立表，不进归因计算。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CircleHelp, Clock, Download, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { getAdminName, getPasscode } from "@/lib/api";

type Side = { cost: number; gross_revenue: number; orders: number; rows: number };
type Report = {
  generated_at: string;
  pass: Record<string, boolean>;
  totals: { api: Side; upload: Side };
  by_type: Record<string, { api: Side; upload: Side }>;
  keys: {
    total: number;
    matched: number;
    only_api: Side & { count: number };
    only_upload: Side & { count: number };
    amount_diff: { count: number };
  };
  account_names: { checked: number; diff: number };
  posted_at: {
    field: string | null;
    checked: number;
    diff: number;
    offset_hist: Record<string, number>;
  };
  warnings: string[];
  uploads?: {
    file_name: string;
    nonzero_cost?: number;
    paired_advertiser?: string | null;
    excluded?: string | null;
  }[];
};
type BatchRow = {
  id: string;
  country: string;
  month: string;
  status: string;
  started_at: string;
  pass: Record<string, boolean> | null;
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/public/hooks/gmv-max-material", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-passcode": getPasscode(),
      "x-admin-name": encodeURIComponent(getAdminName()),
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

const PASS_LABELS: Record<string, string> = {
  totals: "合计",
  key_sets: "视频×商品集合",
  amounts_per_key: "逐项金额",
  account_names: "达人名",
  posted_at: "发布时间",
  no_warnings: "字段",
};
const TYPE_LABELS: Record<string, string> = { video: "视频", product_card: "商品卡", live: "直播" };
const f2 = (v: number) =>
  v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Help({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="inline-flex text-muted-foreground align-middle"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

export function ApiReconcilePanel() {
  const [country, setCountry] = React.useState("VN,JP");
  const [month, setMonth] = React.useState("2026-06");
  const [monthTo, setMonthTo] = React.useState("2026-08");
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<Report | null>(null);
  const [history, setHistory] = React.useState<BatchRow[]>([]);

  const loadHistory = React.useCallback(() => {
    call<{ batches: BatchRow[] }>({ action: "list" })
      .then((r) => setHistory(r.batches))
      .catch(() => undefined);
  }, []);
  React.useEffect(loadHistory, [loadHistory]);

  const drive = async (id: string, label = "") => {
    for (let i = 0; i < 500; i++) {
      const s = await call<{
        done: boolean;
        tt_calls?: number;
        advertiser?: {
          name: string;
          id: string;
          status: string;
          error: string | null;
          pending_campaigns: number | null;
          rows: number;
        };
        advertisers_left?: number;
      }>({ action: "step", batch_id: id });
      if (s.done) break;
      const a = s.advertiser!;
      setProgress(
        `${label}${a.name || a.id}：${a.status === "FAILED" ? `失败 ${a.error}` : `剩 ${a.pending_campaigns ?? "?"} 个 campaign · 已存 ${a.rows} 行`}（待处理户 ${s.advertisers_left}）`,
      );
    }
    setProgress(`${label}对账中…`);
    setReport(await call<Report>({ action: "reconcile", batch_id: id }));
    setProgress("");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
      setProgress("");
    } finally {
      setBusy(false);
      loadHistory();
    }
  };

  const start = () =>
    run(async () => {
      setReport(null);
      // 站点可逗号分隔，月份为起止区间：逐个 站点×月 顺序跑
      const sites = country
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const months: string[] = [];
      for (let m = month; m && m <= (monthTo || month); ) {
        months.push(m);
        const [y, mm] = m.split("-").map(Number);
        m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
      }
      for (const site of sites) {
        for (const m of months) {
          const r = await call<{ batch_id: string }>({ action: "start", country: site, month: m });
          setBatchId(r.batch_id);
          await drive(r.batch_id, `${site} ${m} · `);
          loadHistory();
        }
      }
    });
  const open = (id: string) =>
    run(async () => {
      setBatchId(id);
      const b = await call<{ status: string; report: Report | null }>({
        action: "get",
        batch_id: id,
      });
      if (b.status === "RUNNING") await drive(id);
      else setReport(b.report);
    });
  const retry = () =>
    batchId &&
    run(async () => {
      await call({ action: "retry", batch_id: batchId });
      await drive(batchId);
    });
  // 一次性：探测按 VID 取发布时间的候选接口（结果存库，Claude 读取）
  const probe = () =>
    run(async () => {
      const site = country.split(/[,，\s]+/).filter(Boolean)[0] ?? "";
      setProgress(`${site} 发布时间接口探测中…`);
      await call({ action: "probe_posted", country: site });
      setProgress("");
      toast.success(`${site} 发布时间探测完成`);
    });
  const download = () =>
    batchId &&
    run(async () => {
      const b = await call<Record<string, unknown>>({ action: "get", batch_id: batchId });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `接口对账-${b.country}-${b.month}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const row = (label: string, a: Side, u: Side) => {
    const d = (x: number, y: number) => (
      <span
        className={
          Math.abs(x - y) >= 0.01 ? "text-destructive font-medium" : "text-muted-foreground"
        }
      >
        {f2(x - y)}
      </span>
    );
    return (
      <TableRow key={label}>
        <TableCell>{label}</TableCell>
        <TableCell className="text-right tabular-nums">{f2(a.cost)}</TableCell>
        <TableCell className="text-right tabular-nums">{f2(u.cost)}</TableCell>
        <TableCell className="text-right tabular-nums">{d(a.cost, u.cost)}</TableCell>
        <TableCell className="text-right tabular-nums">{f2(a.gross_revenue)}</TableCell>
        <TableCell className="text-right tabular-nums">{f2(u.gross_revenue)}</TableCell>
        <TableCell className="text-right tabular-nums">
          {d(a.gross_revenue, u.gross_revenue)}
        </TableCell>
        <TableCell className="text-right tabular-nums">{a.orders}</TableCell>
        <TableCell className="text-right tabular-nums">{u.orders}</TableCell>
        <TableCell className="text-right tabular-nums">{d(a.orders, u.orders)}</TableCell>
      </TableRow>
    );
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="站点"
            className="h-8 w-24"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
          />
          <Input
            aria-label="月份"
            type="month"
            className="h-8 w-40"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
          <Input
            aria-label="结束月份"
            type="month"
            className="h-8 w-40"
            value={monthTo}
            onChange={(e) => setMonthTo(e.target.value)}
          />
          <Button size="sm" onClick={start} disabled={busy}>
            {busy ? "进行中…" : "抓取并对账"}
          </Button>
          <Help text="站点可填多个（逗号分隔），月份为起止区间，逐个 站点×月 顺序跑。从接口抓已登记广告户（含未启用）的 GMV MAX 素材数据，与已上传的表逐项比。数据只存独立表，不影响归因结果。" />
          <Button
            size="sm"
            variant="outline"
            onClick={probe}
            disabled={busy}
            aria-label="探测发布时间接口（第一个站点）"
            title="探测发布时间接口（第一个站点）"
          >
            <Clock className="h-4 w-4" />
          </Button>
          {batchId ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={retry}
                disabled={busy}
                aria-label="重试失败的广告户"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={download}
                disabled={busy}
                aria-label="下载完整对账报告"
              >
                <Download className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {progress ? <span className="text-xs text-muted-foreground">{progress}</span> : null}
        </div>

        {report ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(report.pass).map(([k, v]) => (
                <span
                  key={k}
                  className={`text-xs rounded px-2 py-0.5 border ${v ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" : "border-destructive/50 text-destructive"}`}
                >
                  {v ? "✓" : "✗"} {PASS_LABELS[k] ?? k}
                </span>
              ))}
            </div>
            {report.warnings.length ? (
              <ul className="text-xs text-destructive list-disc pl-5 space-y-0.5">
                {report.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead className="text-right">花费·接口</TableHead>
                    <TableHead className="text-right">花费·上传</TableHead>
                    <TableHead className="text-right">差</TableHead>
                    <TableHead className="text-right">GMV·接口</TableHead>
                    <TableHead className="text-right">GMV·上传</TableHead>
                    <TableHead className="text-right">差</TableHead>
                    <TableHead className="text-right">订单·接口</TableHead>
                    <TableHead className="text-right">订单·上传</TableHead>
                    <TableHead className="text-right">差</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {row("合计", report.totals.api, report.totals.upload)}
                  {Object.entries(report.by_type).map(([t, v]) =>
                    row(TYPE_LABELS[t] ?? t, v.api, v.upload),
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>
                键 {report.keys.total.toLocaleString()} · 两边都有{" "}
                {report.keys.matched.toLocaleString()}
              </span>
              <span>
                仅接口 {report.keys.only_api.count}（花费 {f2(report.keys.only_api.cost)}）
              </span>
              <span>
                仅上传 {report.keys.only_upload.count}（花费 {f2(report.keys.only_upload.cost)}）
              </span>
              <span>金额不一致 {report.keys.amount_diff.count}</span>
              <span>
                达人名不一致 {report.account_names.diff}/{report.account_names.checked}
              </span>
              <span>
                发布时间不一致 {report.posted_at.diff}/{report.posted_at.checked}
              </span>
            </div>
            {report.uploads?.length ? (
              <div className="text-xs flex flex-wrap gap-x-4 gap-y-1">
                {report.uploads.map((u) => (
                  <span
                    key={u.file_name}
                    className={u.excluded ? "text-muted-foreground line-through" : ""}
                    title={u.excluded ?? undefined}
                  >
                    {u.file_name}（{f2(u.nonzero_cost ?? 0)}）→ {u.paired_advertiser ?? "未配对"}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {history.length ? (
          <div className="flex flex-wrap gap-1.5">
            {history.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => open(h.id)}
                disabled={busy}
                className={`text-xs rounded border px-2 py-0.5 hover:bg-muted ${h.id === batchId ? "bg-muted" : ""}`}
              >
                {h.country} {h.month} ·{" "}
                {h.status === "RUNNING"
                  ? "未完成"
                  : h.status === "FAILED"
                    ? "失败"
                    : h.pass
                      ? Object.values(h.pass).every(Boolean)
                        ? "✓"
                        : "✗"
                      : "未对账"}
                <span className="text-muted-foreground">
                  {" "}
                  · {new Date(h.started_at).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
