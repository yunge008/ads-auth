import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Download,
  RefreshCw,
  RotateCw,
  Send,
  Upload,
  AlertTriangle,
  Copy,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  HelpCircle,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { useBCAdvertisers, useMaterials, useStaff } from "@/lib/store";
import {
  type Material,
  type MaterialStatus,
  ALL_STATUSES,
} from "@/lib/types";
import { MultiSelect } from "@/components/MultiSelect";
import { STATUS_RANK, StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { invokeFn } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

type AuthorizeLogEntry = {
  id: number;
  logged_at: string;
  source: "manual" | "cron";
  success: number;
  failed: number;
  no_account: number;
  errors: Array<{ vid?: string; error?: string }>;
  note: string | null;
};

async function callAuthorizeLog<T>(body: Record<string, unknown>): Promise<T> {
  return invokeFn<T>("authorize-log", body);
}

const LOG_PAGE_SIZE = 10;
/** 素材表固定行高（px），与 MaterialRow 的 h-10 一致；首行未渲染时用来估算每页行数 */
const MATERIAL_ROW_PX = 40;
/** 授权失败类结果状态（进度条里排在「已授权」之后） */
const OTHER_RESULT_STATUSES: MaterialStatus[] = [
  "代码过期",
  "代码删除",
  "代码有误",
  "代码涉及多素材",
  "视频不可见",
  "API错误",
];
/** 回写飞书处理的状态 */
const WRITEBACK_STATUSES: MaterialStatus[] = [
  "已授权",
  "代码过期",
  "代码删除",
  "代码有误",
  "代码涉及多素材",
  "视频不可见",
  "API错误",
];

function AuthorizeLogPanel({ refreshKey }: { refreshKey: number }) {
  const [logs, setLogs] = React.useState<AuthorizeLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = React.useState(false);
  const [logPage, setLogPage] = React.useState(1);
  const openedRef = React.useRef(false);

  const fetchLogs = React.useCallback(async () => {
    setLoadingLogs(true);
    try {
      const data = await callAuthorizeLog<{ logs: AuthorizeLogEntry[] }>({ action: "list", limit: 50 });
      setLogs(data.logs ?? []);
      setLogPage(1);
    } catch {
      // ignore
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  const logPageCount = Math.max(1, Math.ceil(logs.length / LOG_PAGE_SIZE));
  const pagedLogs = logs.slice((logPage - 1) * LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE);

  React.useEffect(() => {
    if (openedRef.current) fetchLogs();
  }, [refreshKey, fetchLogs]);

  const handleOpenChange = (open: boolean) => {
    openedRef.current = open;
    if (open) fetchLogs();
  };

  function formatBeijing(iso: string, part: "date" | "time") {
    const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
    const s = d.toISOString();
    return part === "date" ? s.slice(0, 10) : s.slice(11, 19);
  }

  return (
    <Collapsible onOpenChange={handleOpenChange}>
      <Card>
        <CollapsibleTrigger className="w-full">
          <CardHeader className="py-3 flex-row items-center justify-between space-y-0 cursor-pointer hover:bg-muted/40 transition-colors">
            <CardTitle className="text-sm font-medium">📋 推送记录</CardTitle>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            {loadingLogs ? (
              <p className="text-sm text-muted-foreground py-4 text-center">加载中…</p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">暂无记录</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">日期</TableHead>
                      <TableHead className="w-20">时间</TableHead>
                      <TableHead className="w-16">来源</TableHead>
                      <TableHead className="w-16 text-green-600">成功</TableHead>
                      <TableHead className="w-16 text-red-500">失败</TableHead>
                      <TableHead className="w-16 text-orange-500">无账号</TableHead>
                      <TableHead>失败原因</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedLogs.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono text-xs">{formatBeijing(row.logged_at, "date")}</TableCell>
                        <TableCell className="font-mono text-xs">{formatBeijing(row.logged_at, "time")}</TableCell>
                        <TableCell>
                          <Badge variant={row.source === "cron" ? "secondary" : "outline"} className="text-xs">
                            {row.source === "cron" ? "自动" : "手动"}
                          </Badge>
                        </TableCell>
                        <TableCell className={cn("text-xs font-medium", row.success > 0 ? "text-green-600" : "text-muted-foreground")}>
                          {row.success}
                        </TableCell>
                        <TableCell className={cn("text-xs font-medium", row.failed > 0 ? "text-red-500" : "text-muted-foreground")}>
                          {row.failed}
                        </TableCell>
                        <TableCell className={cn("text-xs font-medium", row.no_account > 0 ? "text-orange-500" : "text-muted-foreground")}>
                          {row.no_account}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-xs">
                          {Array.isArray(row.errors) && row.errors.length > 0 ? (
                            <span>
                              {row.errors.slice(0, 3).map((e, i) => (
                                <span key={i} className="block truncate">
                                  {e.vid ? <span className="text-foreground">{e.vid}</span> : null}
                                  {e.vid && e.error ? "：" : null}
                                  {e.error}
                                </span>
                              ))}
                              {row.errors.length > 3 && (
                                <span className="text-muted-foreground">+{row.errors.length - 3} 条</span>
                              )}
                            </span>
                          ) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {logs.length > LOG_PAGE_SIZE && (
                  <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                    <div>
                      第 {(logPage - 1) * LOG_PAGE_SIZE + 1}-{Math.min(logPage * LOG_PAGE_SIZE, logs.length)} / 共 {logs.length} 条
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7" disabled={logPage <= 1} onClick={() => setLogPage((p) => Math.max(1, p - 1))}>
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <span>{logPage} / {logPageCount}</span>
                      <Button size="sm" variant="outline" className="h-7" disabled={logPage >= logPageCount} onClick={() => setLogPage((p) => Math.min(logPageCount, p + 1))}>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/** 统计表人员行的异常说明：悬停 / 键盘聚焦 / 点按都能打开。 */
function IssueTip({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded align-middle text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          // 点按只打开：聚焦已打开时 Radix 默认的切换会把它关掉（手机点按 = 聚焦 + 点击）
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-xs break-all" onOpenAutoFocus={(e) => e.preventDefault()}>
        {text}
      </PopoverContent>
    </Popover>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "执行授权 - TikTok授权工具" },
      { name: "description", content: "拉取飞书素材并批量授权 TikTok 广告户" },
    ],
  }),
  component: AuthorizePage,
});

function AuthorizePage() {
  const { advertisers } = useBCAdvertisers();
  const { staff } = useStaff();
  const { materials, setMaterials } = useMaterials();
  const [loadingMode, setLoadingMode] = React.useState<"all" | "pending" | null>(null);
  const loading = loadingMode !== null;
  const [logRefreshKey, setLogRefreshKey] = React.useState(0);
  const [authorizing, setAuthorizing] = React.useState(false);
  // 本次执行授权覆盖的素材 id 集合；执行完毕后不清空，保留到下一次点「执行授权」再覆盖，
  // 这样状态条能一直显示上一次的结果。
  const [authTargetIds, setAuthTargetIds] = React.useState<Set<string> | null>(null);
  // 「待授权账户」面板开关：与素材列表筛选是 AND 关系，默认每次拉取素材后全部开启
  const [enabledAdvertiserIds, setEnabledAdvertiserIds] = React.useState<Set<string>>(new Set());
  // 本次拉取每个请求人员的结果：0 条 / sheet 未找到 / 失败的人也要在统计表里出现，不能静默消失
  const [fetchReport, setFetchReport] = React.useState<
    Array<{ name: string; sheet: string; count: number; issue?: string }>
  >([]);
  const toggleAdvertiserEnabled = (id: string) => {
    setEnabledAdvertiserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // filters
  const [fStaff, setFStaff] = React.useState<string[]>([]);
  const [fCountry, setFCountry] = React.useState<string[]>([]);
  const [fStatus, setFStatus] = React.useState<string[]>([]);
  const [fVid, setFVid] = React.useState("");
  const [fAuth, setFAuth] = React.useState("");

  const advNameById = React.useMemo(
    () => new Map(advertisers.map((a) => [a.advertiser_id, a.advertiser_name])),
    [advertisers],
  );

  const countriesInData = React.useMemo(
    () => Array.from(new Set(materials.map((m) => m.country).filter(Boolean))),
    [materials],
  );

  // Derived account list (country → advertiser) from materials themselves.
  const accounts = React.useMemo(() => {
    const seen = new Map<string, { country: string; advertiser_id: string; advertiser_name: string }>();
    for (const m of materials) {
      if (!m.advertiser_id) continue;
      const k = `${m.country}__${m.advertiser_id}`;
      if (seen.has(k)) continue;
      seen.set(k, {
        country: m.country,
        advertiser_id: m.advertiser_id,
        advertiser_name: advNameById.get(m.advertiser_id) ?? m.advertiser_id,
      });
    }
    return Array.from(seen.values());
  }, [materials, advNameById]);

  const pendingAccounts = React.useMemo(() => {
    const seen = new Set<string>();
    return accounts.filter((a) => {
      if (seen.has(a.advertiser_id)) return false;
      seen.add(a.advertiser_id);
      return true;
    });
  }, [accounts]);


  // Pivot: rows = staff, cols = countries
  const { statsRows, statsCountries, colTotals, grandTotal, warningTotal } = React.useMemo(() => {
    const countrySet = new Set<string>();
    const byStaff = new Map<string, { pendingByCountry: Map<string, number>; warning: number; total: number }>();
    for (const m of materials) {
      countrySet.add(m.country);
      const row = byStaff.get(m.staff_name) ?? { pendingByCountry: new Map(), warning: 0, total: 0 };
      row.pendingByCountry.set(m.country, (row.pendingByCountry.get(m.country) ?? 0) + 1);
      row.total += 1;
      if (m.status === "无授权账号") row.warning += 1;
      byStaff.set(m.staff_name, row);
    }
    const countries = Array.from(countrySet).sort();
    const staffOrder = new Map<string, number>();
    staff.forEach((st, i) => { if (!staffOrder.has(st.name)) staffOrder.set(st.name, i); });
    for (const f of fetchReport) {
      if (!byStaff.has(f.name)) byStaff.set(f.name, { pendingByCountry: new Map(), warning: 0, total: 0 });
    }
    const issueByStaff = new Map(fetchReport.filter((f) => f.issue).map((f) => [f.name, f.issue as string]));
    const rows = Array.from(byStaff.entries())
      .map(([staff_name, v]) => ({ staff_name, ...v, issue: issueByStaff.get(staff_name) }))
      // 按「设置 → 人员表」行顺序；不在人员表里的名字（「授权记录」归档里的人）排在后面按名称排序
      .sort((a, b) => {
        const ia = staffOrder.get(a.staff_name) ?? Infinity;
        const ib = staffOrder.get(b.staff_name) ?? Infinity;
        return ia !== ib ? ia - ib : a.staff_name.localeCompare(b.staff_name);
      });
    const colTotals = countries.map((c) => rows.reduce((s, r) => s + (r.pendingByCountry.get(c) ?? 0), 0));
    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    const warningTotal = rows.reduce((s, r) => s + r.warning, 0);
    return { statsRows: rows, statsCountries: countries, colTotals, grandTotal, warningTotal };
  }, [materials, fetchReport, staff]);


  // Filter only (NO dynamic re-sort — order is frozen at fetch time)
  const visibleMaterials = React.useMemo(() => {
    return materials.filter((m) => {
      if (fStaff.length && !fStaff.includes(m.staff_name)) return false;
      if (fCountry.length && !fCountry.includes(m.country)) return false;
      if (fStatus.length && !fStatus.includes(m.status)) return false;
      if (fVid && !m.vid.toLowerCase().includes(fVid.toLowerCase())) return false;
      if (fAuth && !m.auth_code.toLowerCase().includes(fAuth.toLowerCase())) return false;
      return true;
    });
  }, [materials, fStaff, fCountry, fStatus, fVid, fAuth]);

  const statusCounts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of materials) c[m.status] = (c[m.status] ?? 0) + 1;
    return c;
  }, [materials]);
  const staffCounts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of materials) c[m.staff_name] = (c[m.staff_name] ?? 0) + 1;
    return c;
  }, [materials]);
  const countryCounts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of materials) c[m.country] = (c[m.country] ?? 0) + 1;
    return c;
  }, [materials]);
  const statusOptions = React.useMemo(
    () => [...ALL_STATUSES].sort((a, b) => (STATUS_RANK[a] ?? 99) - (STATUS_RANK[b] ?? 99)),
    [],
  );

  // 分页：每页行数 = 表格区高度 / 行高。素材列表卡片高度固定为一屏，
  // 页面滚到底时整个卡片（工具栏 + 表格 + 翻页）正好在一屏内，不出现表格内滚动。
  const tableBoxRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(15);
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(visibleMaterials.length / pageSize));
  // 只在筛选变化或条数变化时回第 1 页；授权过程中状态刷新不跳页
  React.useEffect(() => { setPage(1); }, [fStaff, fCountry, fStatus, fVid, fAuth, materials.length]);
  React.useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const hasRows = visibleMaterials.length > 0;
  React.useLayoutEffect(() => {
    const el = tableBoxRef.current;
    if (!el) return;
    const calc = () => {
      const head = el.querySelector("thead")?.getBoundingClientRect().height ?? 40;
      const firstRow = hasRows ? el.querySelector("tbody tr") : null;
      const row = firstRow?.getBoundingClientRect().height || MATERIAL_ROW_PX;
      const n = Math.max(5, Math.floor((el.clientHeight - head - 2) / row));
      setPageSize((p) => (p === n ? p : n));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRows]);
  const pagedMaterials = React.useMemo(
    () => visibleMaterials.slice((page - 1) * pageSize, page * pageSize),
    [visibleMaterials, page, pageSize],
  );
  const filterActive = fStaff.length + fCountry.length + fStatus.length > 0 || !!fVid || !!fAuth;
  const clearFilters = () => {
    setFStaff([]);
    setFCountry([]);
    setFStatus([]);
    setFVid("");
    setFAuth("");
  };


  const handleFetch = async (includeDone = false) => {
    // 执行授权只读 BD 角色的建联表；剪辑角色的素材不需要授权码授权，不参与拉取。
    // 「获取所有素材」读人员表内全部 BD（含未启用）；「获取未授权素材」只读启用中的 BD。
    const activeStaff = staff.filter(
      (s) => (includeDone || s.active) && (s.role ?? "BD") === "BD",
    );
    if (activeStaff.length === 0) {
      toast.error(includeDone ? "请先在「设置」中配置 BD 人员" : "请先在「设置」中配置启用的 BD 人员");
      return;
    }
    setLoadingMode(includeDone ? "all" : "pending");
    try {
      // 按人拆成多次请求（并发 3）：一次请求串行读全部大表会超过 Edge Function 150s 墙钟上限，
      // 平台直接返回 non-2xx。「授权记录」归档只由第一个请求读取（skip_archive），
      // 跨请求的 VID+授权码 去重在前端做，口径与原单次请求一致：建联表行优先，归档行去重。
      // 飞书大表冷加载时会返回「data not ready, retry later」等瞬时错误：单人重试，间隔 3/6/12s。
      const TRANSIENT_RE = /not ready|retry later|too many|frequen|timeout|busy/i;
      type ReadResp = { materials: Material[]; missing_sheets?: string[] };
      const readOne = async (s: (typeof activeStaff)[number], withArchive: boolean): Promise<ReadResp> => {
        const payload = {
          // 用后端算好的 resolved_sheet_name：人员表 sheet名 留空的人靠模板生成，
          // 前端自己再算一遍迟早和后端不一致，不一致就是读错表且不报错。
          staff: [{ name: s.name, sheet_name: s.resolved_sheet_name || s.sheet_name }],
          include_done: includeDone,
          skip_archive: !withArchive,
        };
        for (let attempt = 1; ; attempt++) {
          try {
            return await invokeFn<ReadResp>("feishu-read", payload);
          } catch (e) {
            if (attempt >= 4 || !TRANSIENT_RE.test((e as Error).message)) throw e;
            toast.info(`${s.name}：飞书数据未就绪，${3 * 2 ** (attempt - 1)} 秒后第 ${attempt} 次重试…`);
            await new Promise((r) => setTimeout(r, 3000 * 2 ** (attempt - 1)));
          }
        }
      };
      const results: Array<{ name: string; resp?: ReadResp; err?: string }> = activeStaff.map((s) => ({ name: s.name }));
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, activeStaff.length) }, async () => {
          while (next < activeStaff.length) {
            const idx = next++;
            try {
              results[idx].resp = await readOne(activeStaff[idx], includeDone && idx === 0);
            } catch (e) {
              results[idx].err = (e as Error).message;
            }
          }
        }),
      );
      const failed = results.filter((r) => r.err);
      if (failed.length === results.length) throw new Error(failed.map((r) => `${r.name}：${r.err}`).join("；"));
      const ARCHIVE = "授权记录";
      const staffRows: Material[] = [];
      const archiveRows: Material[] = [];
      const missing = new Set<string>();
      results.forEach((r, idx) => {
        for (const m of r.resp?.materials ?? []) {
          if (m.sheet_name === ARCHIVE) {
            // 未部署 skip_archive 的旧后端每次都会带归档，只取第一个请求的
            if (idx === 0) archiveRows.push(m);
          } else staffRows.push(m);
        }
        for (const ms of r.resp?.missing_sheets ?? []) if (ms !== ARCHIVE || idx === 0) missing.add(ms);
      });
      // 「获取所有素材」按授权码去重：同一授权码只留一条（建联表优先于「授权记录」归档，
      // 建联表内按人员表顺序、行号先到先得）；同一 VID 不同授权码都保留。
      // 「获取未授权素材」不去重：每行都要按 sheet+行号 回写 V/W。
      const seenCode = new Set<string>();
      const firstByCode = (m: Material) => {
        const k = m.auth_code.trim();
        if (seenCode.has(k)) return false;
        seenCode.add(k);
        return true;
      };
      const merged = includeDone
        ? [...staffRows.filter(firstByCode), ...archiveRows.filter(firstByCode)]
        : [...staffRows, ...archiveRows];
      const dupDropped = staffRows.length + archiveRows.length - merged.length;
      const data: ReadResp = { materials: merged, missing_sheets: [...missing] };
      setFetchReport(
        results.map((r, idx) => {
          const sheet = activeStaff[idx].resolved_sheet_name || activeStaff[idx].sheet_name;
          const count = (r.resp?.materials ?? []).filter((m) => m.sheet_name !== ARCHIVE).length;
          const issue = r.err
            ? `拉取失败：${r.err}`
            : r.resp?.missing_sheets?.includes(sheet)
              ? `飞书无 sheet「${sheet}」`
              : count === 0
                ? `sheet「${sheet}」0 条：没有「P 列 VID 非空且 Q 列授权码格式合法」的行（如授权码列为空）`
                : undefined;
          return { name: r.name, sheet, count, issue };
        }),
      );
      if (failed.length) {
        const archiveLost = includeDone && results[0].err ? "（含「授权记录」归档）" : "";
        toast.error(`${failed.length} 人拉取失败${archiveLost}，数据不完整：${failed.map((r) => `${r.name}：${r.err}`).join("；")}`, { duration: 20000 });
      }
      const list = (data?.materials ?? []).map((m) => ({
        ...m,
        advertiser_name: m.advertiser_id
          ? (advNameById.get(m.advertiser_id) ?? m.advertiser_id)
          : m.advertiser_name,
      })) as Material[];
      const sorted = [...list].sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          a.staff_name.localeCompare(b.staff_name) ||
          a.row_number - b.row_number,
      );
      setMaterials(sorted);
      // 待授权账户开关：每次重新拉取后默认全部开启
      setEnabledAdvertiserIds(
        new Set(list.filter((m) => m.advertiser_id).map((m) => m.advertiser_id as string)),
      );
      if (data?.missing_sheets?.length) {
        toast.warning(`以下 sheet 未找到：${data.missing_sheets.join(", ")}`);
      }
      toast.success(`已拉取 ${list.length} 条素材` + (dupDropped > 0 ? `（按授权码去重 ${dupDropped} 条）` : ""));

    } catch (e) {
      toast.error(`拉取失败：${(e as Error).message}`);
    } finally {
      setLoadingMode(null);
    }
  };

  const AUTH_CHUNK_SIZE = 200;
  const AUTH_MAX_CONCURRENT = 3;

  // 执行授权的目标：当前筛选可见 + 待授权/API错误 + 有广告户和授权码 + 广告户在「待授权账户」中开启
  const authCandidates = React.useMemo(
    () =>
      visibleMaterials.filter(
        (m) =>
          (m.status === "待授权" || m.status === "API错误") &&
          m.advertiser_id &&
          m.auth_code &&
          enabledAdvertiserIds.has(m.advertiser_id),
      ),
    [visibleMaterials, enabledAdvertiserIds],
  );
  const writebackCount = React.useMemo(
    () => materials.filter((m) => WRITEBACK_STATUSES.includes(m.status)).length,
    [materials],
  );

  const handleAuthorize = async () => {
    const targets = authCandidates;
    if (targets.length === 0) {
      toast.error("没有可执行授权的素材（待授权 / API错误，且账户已在「待授权账户」中开启）");
      return;
    }
    const targetIds = new Set(targets.map((t) => t.id));
    setAuthTargetIds(targetIds);
    setAuthorizing(true);

    // 每个素材最新的处理结果，独立于 materials 状态记录一份，用于判断本轮结束后
    // 是否还有 API错误 需要自动补跑，不依赖读取可能还没提交完的 React 状态。
    const resultById = new Map<string, { status: MaterialStatus; error_message?: string }>();

    const runChunk = async (chunk: Material[]) => {
      try {
        const data = await invokeFn<{ results: { id: string; status: MaterialStatus; error_message?: string }[] }>(
          "authorize-batch",
          {
            items: chunk.map((t) => ({
              id: t.id,
              advertiser_id: t.advertiser_id,
              auth_code: t.auth_code,
              vid: t.vid,
            })),
          },
        );
        const byId = new Map<string, { status: MaterialStatus; error_message?: string }>(
          (data?.results ?? []).map((r) => [r.id, { status: r.status, error_message: r.error_message }]),
        );
        for (const [id, r] of byId) resultById.set(id, r);
        setMaterials((prev) =>
          prev.map((m) => {
            const r = byId.get(m.id);
            return r ? { ...m, status: r.status, error_message: r.error_message } : m;
          }),
        );
      } catch (e) {
        // 整批调用失败（如超时）：标记为「API错误」，本轮结束后会自动补跑一次。
        const msg = (e as Error).message;
        for (const t of chunk) resultById.set(t.id, { status: "API错误", error_message: msg });
        const chunkIds = new Set(chunk.map((t) => t.id));
        setMaterials((prev) =>
          prev.map((m) => (chunkIds.has(m.id) ? { ...m, status: "API错误", error_message: msg } : m)),
        );
      }
    };

    // 大批量分块 + 有限并行提交，避免单次调用跑太久被平台超时掐断（504）。
    const runBatch = async (items: Material[]) => {
      const ids = new Set(items.map((t) => t.id));
      setMaterials((prev) =>
        prev.map((m) => (ids.has(m.id) ? { ...m, status: "授权中", error_message: undefined } : m)),
      );
      const chunks: Material[][] = [];
      for (let i = 0; i < items.length; i += AUTH_CHUNK_SIZE) {
        chunks.push(items.slice(i, i + AUTH_CHUNK_SIZE));
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < chunks.length) {
          const chunk = chunks[cursor++];
          await runChunk(chunk);
        }
      };
      await Promise.all(Array.from({ length: Math.min(AUTH_MAX_CONCURRENT, chunks.length) }, worker));
    };

    await runBatch(targets);

    // 结束后如果还有 API错误（含请求本身失败的），自动补跑一轮，跑完才算最终结果。
    const retryTargets = targets.filter((t) => resultById.get(t.id)?.status === "API错误");
    if (retryTargets.length > 0) {
      await runBatch(retryTargets);
    }

    setAuthorizing(false);
    toast.success(
      `已处理 ${targets.length} 条` +
        (retryTargets.length > 0 ? `（其中 ${retryTargets.length} 条 API错误已自动重试一次）` : ""),
    );
  };

  // 本次执行授权的进度：进度条 + 各结果状态计数（已授权 → 各类失败 → 授权中，0 的不显示）。
  const authStats = React.useMemo(() => {
    if (!authTargetIds) return null;
    const counts: Partial<Record<MaterialStatus, number>> = {};
    for (const m of materials) {
      if (!authTargetIds.has(m.id)) continue;
      counts[m.status] = (counts[m.status] ?? 0) + 1;
    }
    const pending = counts["授权中"] ?? 0;
    const order: MaterialStatus[] = ["已授权", ...OTHER_RESULT_STATUSES, "授权中"];
    return {
      total: authTargetIds.size,
      done: authTargetIds.size - pending,
      parts: order.filter((s) => (counts[s] ?? 0) > 0).map((s) => [s, counts[s] as number] as const),
    };
  }, [authTargetIds, materials]);

  const handleWriteback = async () => {
    const targets = materials.filter((m) => WRITEBACK_STATUSES.includes(m.status));
    if (targets.length === 0) {
      toast.error("没有可回写的素材");
      return;
    }
    try {
      const data = await invokeFn<{ updated?: number; logged?: number }>("feishu-writeback", {
        items: targets.map((m) => ({
          sheet_name: m.sheet_name,
          row_number: m.row_number,
          status: m.status,
          error_message: m.error_message,
          country: m.country,
          creator_name: m.creator_name,
          vid: m.vid,
          auth_code: m.auth_code,
          product: m.product,
          staff_name: m.staff_name,
          advertiser_name: m.advertiser_name,
          advertiser_id: m.advertiser_id,
        })),
      });
      // Keep API错误 items visible; remove the rest (P/Q written back).
      const removeIds = new Set(
        targets.filter((t) => t.status !== "API错误").map((t) => t.id),
      );
      setMaterials((prev) => prev.filter((m) => !removeIds.has(m.id)));
      const logMsg = data?.logged ? `，记录 ${data.logged} 条到「授权记录」` : "";
      toast.success(`已回写 ${data?.updated ?? targets.length} 条到飞书${logMsg}`);

      // Append to authorize_log via Server Route
      const logSuccess = targets.filter((t) => t.status === "已授权").length;
      const logFailed = targets.filter((t) => t.status !== "已授权" && t.status !== "API错误").length;
      const logNoAccount = materials.filter((m) => m.status === "无授权账号").length;
      const failedItems = targets.filter((t) => t.status !== "已授权" && t.status !== "API错误");
      callAuthorizeLog({ action: "append", source: "manual", success: logSuccess, failed: logFailed, no_account: logNoAccount, errors: failedItems.slice(0, 20).map((t) => ({ vid: t.vid ?? "", error: t.error_message ?? t.status })) })
        .then(() => setLogRefreshKey((k) => k + 1))
        .catch(() => {}); // non-critical
    } catch (e) {
      toast.error(`回写失败：${(e as Error).message}`);
    }
  };



  const handleCopyAuthCodes = async () => {
    const codes = visibleMaterials.map((m) => m.auth_code).filter(Boolean);
    if (codes.length === 0) {
      toast.error("没有可复制的授权码");
      return;
    }
    const text = codes.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${codes.length} 个授权码`);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const handleDownload = () => {
    if (materials.length === 0) {
      toast.error("没有可下载的数据");
      return;
    }
    const headers = [
      "人员姓名","sheet名","行号","登记日期","国家","达人名称","VID","授权码","产品","广告户名称","广告户ID","状态","错误信息",
    ];
    const rows = materials.map((m) => [
      m.staff_name, m.sheet_name, m.row_number, m.register_date, m.country, m.creator_name,
      m.vid, m.auth_code, m.product, m.advertiser_name ?? "",
      m.advertiser_id ?? "", m.status, m.error_message ?? "",
    ]);
    const csv =
      "\uFEFF" +
      [headers, ...rows]
        .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
        .join("\n");
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 15)
      .replace(/(\d{8})(\d{6})/, "$1_$2");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TikTok授权结果_${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">执行授权</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => handleFetch(true)} disabled={loading}>
            <RotateCw className={cn("h-4 w-4 mr-1.5", loadingMode === "all" && "animate-spin")} />
            获取所有素材
          </Button>
          <Button onClick={() => handleFetch(false)} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4 mr-1.5", loadingMode === "pending" && "animate-spin")} />
            获取未授权素材
          </Button>
        </div>
      </div>

      <Collapsible>
        <Card>
          <CollapsibleTrigger className="w-full">
            <CardHeader className="py-3 flex-row items-center justify-between space-y-0 cursor-pointer hover:bg-muted/40 transition-colors">
              <CardTitle className="text-sm font-medium">📖 使用说明</CardTitle>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <Tabs defaultValue="flow">
                <TabsList>
                  <TabsTrigger value="flow">操作指引与执行逻辑</TabsTrigger>
                  <TabsTrigger value="read">飞书原表列位置与读取</TabsTrigger>
                  <TabsTrigger value="writeback">回写飞书位置与逻辑</TabsTrigger>
                </TabsList>

                <TabsContent value="flow" className="text-sm space-y-3 leading-relaxed">
                  <div>
                    <div className="font-medium mb-1">操作流程</div>
                    <p className="text-muted-foreground">获取素材 →（可选筛选 / 手动指派国家）→ 执行授权 → 回写飞书。</p>
                  </div>
                  <div>
                    <div className="font-medium mb-1">两种拉取模式</div>
                    <ul className="list-disc pl-5 text-muted-foreground space-y-1">
                      <li><b>获取未授权素材</b>：仅启用中的 BD；须同时满足 V 列（code 授权日期/投放日期）为空、P 列 VID 非空、Q 列授权码格式合法；C 列国家须符合格式，N 列视频登记日期可为空，填写时须为可识别日期。适用于每日授权。</li>
                      <li><b>获取所有素材</b>：人员表内全部 BD（含未启用）的建联表中 P 列 VID 非空且 Q 列授权码格式合法的行（不看 V 列，国家/日期无效不剔除，国家未匹配广告户时标为「无授权账号」），并合并「授权记录」M:S 列的原始 code 归档（第 3 行起），<b>按授权码去重</b>：同一授权码只保留一条（建联表优先于归档，建联表内按人员表顺序、行号先到先得），同一 VID 不同授权码都保留。一般只授权不回写；如点回写，只写回建联表行的 V/W，归档行只记到「授权记录」A:K。适用于批量授权新账户。</li>
                      <li><b>注意</b>：只有授权码、P 列 VID 为空的行，两种模式都不会返回；仅 V 列为空不足以纳入。</li>
                    </ul>
                  </div>
                  <div>
                    <div className="font-medium mb-1">广告户匹配</div>
                    <p className="text-muted-foreground">
                      素材 C 列国家 → 查 advertiser_countries 表得到该国家的广告户（且广告户须存在于某条 TikTok 连接中），取第一个匹配；
                      无匹配 → 状态「无授权账号」（红色警告行，可手动下拉指派国家补救）。
                    </p>
                  </div>
                  <div>
                    <div className="font-medium mb-1">执行授权的目标筛选</div>
                    <p className="text-muted-foreground">
                      仅当前筛选可见、状态为「待授权」或「API错误」（用于重试）、且同时有广告户ID和授权码的行。调用 TikTok 授权接口：
                    </p>
                    <ul className="list-disc pl-5 text-muted-foreground space-y-1 mt-1">
                      <li>成功 → 已授权</li>
                      <li>失败按报错映射：过期→代码过期；已删除/不存在→代码删除；视频不公开→视频不可见；无效→代码有误；涉及多素材→代码涉及多素材；其他→API错误</li>
                      <li>限速自动退避重试 4 次；同一广告户串行，不同广告户最多 8 个并行</li>
                    </ul>
                  </div>
                  <div>
                    <div className="font-medium mb-1">排序</div>
                    <p className="text-muted-foreground">拉取后按 状态 → 人员 → 行号 排序，之后冻结不再动态重排。素材列表每页行数按屏幕高度自动计算，页面滚到底时整块列表在一屏内。</p>
                  </div>
                </TabsContent>

                <TabsContent value="read" className="text-sm space-y-3 leading-relaxed">
                  <div>
                    <div className="font-medium mb-1">读取范围</div>
                    <p className="text-muted-foreground">
                      按「设置」中启用人员的 sheet 名（建联-姓名）定位，读 A2:W；sheet 找不到会提示。
                    </p>
                  </div>
                  <div>
                    <div className="font-medium mb-1">固定列布局</div>
                    <div className="border rounded-md overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-16 text-xs">列</TableHead>
                            <TableHead className="text-xs">内容</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[
                            ["C", "地区/店铺（国家）"],
                            ["D", "用户名（达人名称）"],
                            ["K", "SKU（样品寄送）"],
                            ["N", "视频登记日期"],
                            ["P", "VID"],
                            ["Q", "授权码 VID CODE(# + 63 位字符 + =)"],
                            ["V", "投放日期 / code授权日期（回写）"],
                            ["W", "状态 / code授权错误原因（回写）"],
                          ].map(([c, v]) => (
                            <TableRow key={c}>
                              <TableCell className="font-mono text-xs py-1.5">{c}</TableCell>
                              <TableCell className="text-xs py-1.5">{v}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                  <div>
                    <div className="font-medium mb-1">行筛选条件（全部满足才纳入）</div>
                    <ul className="list-disc pl-5 text-muted-foreground space-y-1">
                      <li>Q 列授权码格式合法，且 P 列 VID 非空（两种模式都要求）</li>
                      <li>未授权模式下额外要求：N 列（视频登记日期）若有值必须是可识别日期；C 列国家 1–10 字符（中英文/数字/横杠/空格）；V 列（投放日期）为空</li>
                      <li>所有素材模式下：仅要求授权码+VID，国家/日期无效不剔除；并合并「授权记录」M:S 归档数据，按授权码去重</li>
                    </ul>
                  </div>
                </TabsContent>

                <TabsContent value="writeback" className="text-sm space-y-3 leading-relaxed">
                  <div>
                    <div className="font-medium mb-1">回写触发状态</div>
                    <p className="text-muted-foreground">
                      已授权、代码过期、代码删除、代码有误、代码涉及多素材、视频不可见、API错误。
                    </p>
                  </div>
                  <div>
                    <div className="font-medium mb-1">① 各同事原表（按 sheet 名 + 行号定位）</div>
                    <ul className="list-disc pl-5 text-muted-foreground space-y-1">
                      <li><b>已授权</b> → V 列写当天日期 <span className="font-mono">yyyy/mm/dd</span></li>
                      <li><b>代码有误 / 代码删除 / 代码过期 / 代码涉及多素材 / 视频不可见</b> → V 列写日期 + W 列写中文状态</li>
                      <li>来自「授权记录」M:S 归档的素材：不回写原表（归档区固定不再更新），仅记录到下方汇总表</li>
                      <li><b>API错误</b> → 不写原表，仅记录到汇总表；回写后仍保留在页面列表中可重试（其他状态回写后从列表移除）</li>
                    </ul>
                  </div>
                  <div>
                    <div className="font-medium mb-1">② 汇总表「授权记录」sheet（所有有 VID+授权码 的回写项都记录）</div>
                    <div className="border rounded-md overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">列</TableHead>
                            <TableHead className="text-xs">内容</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[
                            ["A", "序号"],
                            ["B", "国家"],
                            ["C", "达人名字"],
                            ["D", "VID"],
                            ["E", "视频CODE（授权码）"],
                            ["F", "产品"],
                            ["G", "投放时间（北京时间 YYYYMMDD HH:MM:SS）"],
                            ["H", "投手备注"],
                            ["I", "同事"],
                            ["J", "广告户名称"],
                            ["K", "广告户ID"],
                          ].map(([c, v]) => (
                            <TableRow key={c}>
                              <TableCell className="font-mono text-xs py-1.5 w-16">{c}</TableCell>
                              <TableCell className="text-xs py-1.5">{v}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <ul className="list-disc pl-5 text-muted-foreground space-y-1 mt-2">
                      <li>不去重覆盖：每次授权（含同一 VID+授权码 换广告户重授权、重试）都单独追加一行，序号 = 表内最大值 + 1，完整保留历史</li>
                      <li>H 投手备注 = 状态文本；API错误附带报错信息</li>
                      <li>A:K 是完整的实时记录块；历史归档区已挪到 M:S（L 为缓冲空列），不会被写入覆盖</li>
                      <li>「授权记录」sheet 不存在时跳过不报错</li>
                    </ul>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <AuthorizeLogPanel refreshKey={logRefreshKey} />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              待授权账户{" "}
              <span className="text-xs font-normal text-muted-foreground ml-1">
                （本次匹配 {pendingAccounts.length} 个国家）
              </span>
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={pendingAccounts.length === 0}
                onClick={() => setEnabledAdvertiserIds(new Set(pendingAccounts.map((p) => p.advertiser_id)))}
              >
                全部启用
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={pendingAccounts.length === 0}
                onClick={() => setEnabledAdvertiserIds(new Set())}
              >
                全部禁用
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">国家</TableHead>
                    <TableHead>广告户名称</TableHead>
                    <TableHead>广告户ID</TableHead>
                    <TableHead className="w-16">启用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingAccounts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-20 text-center text-sm text-muted-foreground">
                        点击「获取未授权素材」后此处显示匹配到的广告户
                      </TableCell>
                    </TableRow>
                  ) : (
                    pendingAccounts.map((p) => (
                      <TableRow key={p.country}>
                        <TableCell>{p.country}</TableCell>
                        <TableCell>{p.advertiser_name}</TableCell>
                        <TableCell className="font-mono text-xs">{p.advertiser_id}</TableCell>
                        <TableCell>
                          <Switch
                            checked={enabledAdvertiserIds.has(p.advertiser_id)}
                            onCheckedChange={() => toggleAdvertiserEnabled(p.advertiser_id)}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">
              抓取数据统计{" "}
              {warningTotal > 0 && (
                <span className="ml-1 inline-flex items-center gap-1 text-xs font-normal text-red-600">
                  <AlertTriangle className="h-3 w-3" />
                  {warningTotal} 条警告
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background">人员姓名</TableHead>
                    {statsCountries.map((c) => (
                      <TableHead key={c} className="text-right">{c}</TableHead>
                    ))}
                    <TableHead className="text-right">汇总</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statsRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={2} className="h-20 text-center text-sm text-muted-foreground">
                        暂无数据
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {statsRows.map((r) => (
                        <TableRow key={r.staff_name}>
                          <TableCell className="sticky left-0 bg-background">
                            {r.staff_name}
                            {r.warning > 0 && (
                              <span className="ml-1 text-xs text-red-600">({r.warning}警告)</span>
                            )}
                            {r.issue && <IssueTip text={r.issue} />}
                          </TableCell>
                          {statsCountries.map((c) => {
                            const v = r.pendingByCountry.get(c) ?? 0;
                            return (
                              <TableCell key={c} className="text-right tabular-nums">
                                {v || <span className="text-muted-foreground">—</span>}
                              </TableCell>
                            );
                          })}
                          <TableCell className="text-right tabular-nums font-medium">{r.total}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/40 font-medium">
                        <TableCell className="sticky left-0 bg-muted/40">合计</TableCell>
                        {colTotals.map((v, i) => (
                          <TableCell key={i} className="text-right tabular-nums">{v}</TableCell>
                        ))}
                        <TableCell className="text-right tabular-nums">{grandTotal}</TableCell>
                      </TableRow>
                    </>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>


      <Card className="flex flex-col h-[calc(100dvh-3rem)] min-h-[520px]" aria-label="素材列表">
        <CardHeader className="space-y-2 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base flex items-baseline gap-2">
              素材列表
              <span className="text-xs font-normal text-muted-foreground tabular-nums" aria-label="当前显示 / 全部条数">
                {visibleMaterials.length} / {materials.length}
              </span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" onClick={handleAuthorize} disabled={authorizing || authCandidates.length === 0}>
                <Send className={cn("h-4 w-4 mr-1.5", authorizing && "animate-pulse")} />
                执行授权
                <span className="ml-1.5 rounded bg-primary-foreground/20 px-1.5 text-xs tabular-nums" aria-label="本次将授权条数">
                  {authCandidates.length}
                </span>
              </Button>
              <HelpTip label="执行授权范围" text="当前筛选可见、状态为「待授权」或「API错误」、有广告户和授权码，且广告户在「待授权账户」中已开启的素材。" />
              <Button size="sm" variant="outline" onClick={handleWriteback} disabled={authorizing || writebackCount === 0}>
                <Upload className="h-4 w-4 mr-1.5" />
                回写飞书
                <span className="ml-1.5 text-xs tabular-nums text-muted-foreground" aria-label="待回写条数">{writebackCount}</span>
              </Button>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleCopyAuthCodes} aria-label="复制当前筛选的授权码" title="复制当前筛选的授权码">
                <Copy className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleDownload} aria-label="下载全部素材到 Excel" title="下载全部素材到 Excel">
                <Download className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div role="toolbar" aria-label="素材筛选" className="flex flex-wrap items-center gap-2">
            <MultiSelect hideLabel label="状态" options={statusOptions} value={fStatus} onChange={setFStatus} counts={statusCounts} />
            <MultiSelect hideLabel label="人员" options={staff.map((s) => s.name)} value={fStaff} onChange={setFStaff} counts={staffCounts} />
            <MultiSelect hideLabel label="国家" options={countriesInData} value={fCountry} onChange={setFCountry} counts={countryCounts} />
            <Input
              value={fVid}
              onChange={(e) => setFVid(e.target.value)}
              placeholder="VID"
              aria-label="VID 模糊搜索"
              className="h-8 w-44 font-mono text-xs"
            />
            <Input
              value={fAuth}
              onChange={(e) => setFAuth(e.target.value)}
              placeholder="授权码"
              aria-label="授权码模糊搜索"
              className="h-8 flex-1 min-w-[10rem] max-w-sm font-mono text-xs"
            />
            {filterActive && (
              <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={clearFilters}>
                <X className="h-3.5 w-3.5 mr-1" />
                清空筛选
              </Button>
            )}
          </div>

          {authStats && (
            <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{authorizing ? "授权中" : "授权完毕"}</span>
                <div
                  className="h-1.5 w-32 rounded-full bg-muted overflow-hidden"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={authStats.total}
                  aria-valuenow={authStats.done}
                  aria-label="授权进度"
                >
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${authStats.total ? (authStats.done / authStats.total) * 100 : 0}%` }}
                  />
                </div>
                <span className="tabular-nums text-muted-foreground">
                  {authStats.done}/{authStats.total}
                </span>
              </div>
              {authStats.parts.map(([st, n]) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setFStatus([st])}
                  aria-label={`只看${st}（${n} 条）`}
                  className="inline-flex items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <StatusBadge status={st} />
                  <span className="tabular-nums">{n}</span>
                </button>
              ))}
            </div>
          )}
        </CardHeader>

        <CardContent className="flex-1 min-h-0 flex flex-col pb-3">
          <div ref={tableBoxRef} className="flex-1 min-h-0 border rounded-md overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>人员</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>国家</TableHead>
                  <TableHead>广告户</TableHead>
                  <TableHead>达人</TableHead>
                  <TableHead>VID</TableHead>
                  <TableHead>授权码</TableHead>
                  <TableHead>产品</TableHead>
                  <TableHead>登记日期</TableHead>
                  <TableHead>错误信息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMaterials.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                      {materials.length === 0 ? "暂无素材数据" : "没有符合筛选的素材"}
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedMaterials.map((m) => (
                    <MaterialRow
                      key={m.id}
                      m={m}
                      accounts={accounts}
                      onAssignCountry={(country) => {
                        const acc = accounts.find((a) => a.country === country);
                        setMaterials((prev) =>
                          prev.map((x) =>
                            x.id === m.id
                              ? {
                                  ...x,
                                  country,
                                  advertiser_id: acc?.advertiser_id,
                                  advertiser_name: acc?.advertiser_name,
                                  status: acc ? "待授权" : "无授权账号",
                                }
                              : x,
                          ),
                        );
                      }}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {visibleMaterials.length > pageSize && (
            <nav aria-label="素材分页" className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <div className="tabular-nums">
                {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, visibleMaterials.length)} / {visibleMaterials.length}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="tabular-nums">{page} / {pageCount}</span>
                <Button size="sm" variant="outline" className="h-7" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </nav>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MaterialRow({
  m,
  accounts,
  onAssignCountry,
}: {
  m: Material;
  accounts: { country: string; advertiser_name: string; advertiser_id: string }[];
  onAssignCountry: (country: string) => void;
}) {
  const isWarn = m.status === "无授权账号";
  const adv = m.advertiser_name ? `${m.advertiser_name}${m.advertiser_id && m.advertiser_id !== m.advertiser_name ? ` · ${m.advertiser_id}` : ""}` : "";
  return (
    <TableRow className={cn("h-10 [&>td]:py-1 [&>td]:whitespace-nowrap", isWarn && "bg-red-50/60 hover:bg-red-50")}>
      <TableCell>{m.staff_name}</TableCell>
      <TableCell>
        <StatusBadge status={m.status as MaterialStatus} />
      </TableCell>
      <TableCell>
        {isWarn ? (
          <Select value="" onValueChange={onAssignCountry}>
            <SelectTrigger className="h-7 w-28 text-xs" aria-label={`为 ${m.vid} 指派国家`}>
              <SelectValue placeholder={m.country || "选择"} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.advertiser_id} value={a.country}>
                  {a.country} · {a.advertiser_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          m.country
        )}
      </TableCell>
      <TableCell className="text-xs max-w-[180px] truncate" title={adv || undefined}>
        {m.advertiser_name ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="max-w-[160px] truncate" title={m.creator_name}>{m.creator_name}</TableCell>
      <TableCell className="font-mono text-xs">{m.vid}</TableCell>
      <TableCell className="font-mono text-xs max-w-[160px] truncate" title={m.auth_code}>
        {m.auth_code}
      </TableCell>
      <TableCell className="max-w-[120px] truncate" title={m.product}>{m.product}</TableCell>
      <TableCell className="text-xs tabular-nums">{m.register_date}</TableCell>
      <TableCell className="text-xs text-red-600 max-w-[220px] truncate" title={m.error_message}>
        {m.error_message ?? ""}
      </TableCell>
    </TableRow>
  );
}

/** 局部说明：「?」图标，悬停 / 键盘聚焦 / 点按都能打开。 */
function HelpTip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}：${text}`}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          // 点按只打开：聚焦已打开时 Radix 默认的切换会把它关掉（手机点按 = 聚焦 + 点击）
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs leading-relaxed" onOpenAutoFocus={(e) => e.preventDefault()}>
        {text}
      </PopoverContent>
    </Popover>
  );
}
