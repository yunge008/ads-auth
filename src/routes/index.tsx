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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Download,
  RefreshCw,
  Send,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useAccounts, useMaterials, useStaff } from "@/lib/store";
import {
  ALL_STATUSES,
  type Material,
  type MaterialStatus,
} from "@/lib/types";
import { MultiSelect } from "@/components/MultiSelect";
import { STATUS_RANK, StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { invokeFn } from "@/lib/api";

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
  const { accounts } = useAccounts();
  const { staff } = useStaff();
  const { materials, setMaterials } = useMaterials();
  const [loading, setLoading] = React.useState(false);

  // filters
  const [fStaff, setFStaff] = React.useState<string[]>([]);
  const [fCountry, setFCountry] = React.useState<string[]>([]);
  const [fStatus, setFStatus] = React.useState<string[]>([]);
  const [fVid, setFVid] = React.useState("");
  const [fAuth, setFAuth] = React.useState("");

  const countriesInData = React.useMemo(
    () => Array.from(new Set(materials.map((m) => m.country).filter(Boolean))),
    [materials],
  );

  const pendingAccounts = React.useMemo(() => {
    const seen = new Set<string>();
    const list: { country: string; advertiser_name: string; advertiser_id: string }[] = [];
    for (const m of materials) {
      if (!m.advertiser_id || seen.has(m.country)) continue;
      seen.add(m.country);
      list.push({
        country: m.country,
        advertiser_name: m.advertiser_name!,
        advertiser_id: m.advertiser_id,
      });
    }
    return list;
  }, [materials]);

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
    const rows = Array.from(byStaff.entries())
      .map(([staff_name, v]) => ({ staff_name, ...v }))
      .sort((a, b) => a.staff_name.localeCompare(b.staff_name));
    const colTotals = countries.map((c) => rows.reduce((s, r) => s + (r.pendingByCountry.get(c) ?? 0), 0));
    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    const warningTotal = rows.reduce((s, r) => s + r.warning, 0);
    return { statsRows: rows, statsCountries: countries, colTotals, grandTotal, warningTotal };
  }, [materials]);


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

  const handleFetch = async () => {
    const activeStaff = staff.filter((s) => s.active);
    if (activeStaff.length === 0) {
      toast.error("请先在「设置」中配置启用的人员");
      return;
    }
    setLoading(true);
    try {
      const data = await invokeFn<{ materials: Material[]; missing_sheets?: string[] }>("feishu-read", {
        staff: activeStaff.map((s) => ({ name: s.name, sheet_name: s.sheet_name })),
        accounts: accounts.map((a) => ({
          country: a.country,
          advertiser_name: a.advertiser_name,
          advertiser_id: a.advertiser_id,
        })),
      });
      const list = (data?.materials ?? []) as Material[];
      // Sort ONCE at fetch time, then freeze order
      const sorted = [...list].sort(
        (a, b) =>
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          a.staff_name.localeCompare(b.staff_name) ||
          a.row_number - b.row_number,
      );
      setMaterials(sorted);
      if (data?.missing_sheets?.length) {
        toast.warning(`以下 sheet 未找到：${data.missing_sheets.join(", ")}`);
      }
      toast.success(`已拉取 ${list.length} 条素材`);
    } catch (e) {
      toast.error(`拉取失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorize = async () => {
    const targets = materials.filter(
      (m) => m.status === "待授权" && m.advertiser_id && m.auth_code,
    );
    if (targets.length === 0) {
      toast.error("没有可执行授权的素材");
      return;
    }
    setMaterials((prev) =>
      prev.map((m) =>
        targets.find((t) => t.id === m.id) ? { ...m, status: "授权中" } : m,
      ),
    );
    try {
      const data = await invokeFn<{ results: { id: string; status: MaterialStatus; error_message?: string }[] }>(
        "authorize-batch",
        {
          items: targets.map((t) => ({
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
      setMaterials((prev) =>
        prev.map((m) => {
          const r = byId.get(m.id);
          return r ? { ...m, status: r.status, error_message: r.error_message } : m;
        }),
      );
      toast.success(`已处理 ${targets.length} 条`);
    } catch (e) {
      toast.error(`授权失败：${(e as Error).message}`);
      setMaterials((prev) =>
        prev.map((m) =>
          targets.find((t) => t.id === m.id) ? { ...m, status: "待授权" } : m,
        ),
      );
    }
  };

  const handleWriteback = async () => {
    const targets = materials.filter(
      (m) => m.status !== "待授权" && m.status !== "授权中",
    );
    if (targets.length === 0) {
      toast.error("没有可回写的素材");
      return;
    }
    try {
      const data = await invokeFn<{ updated?: number }>("feishu-writeback", {
        items: targets.map((m) => ({
          sheet_name: m.sheet_name,
          row_number: m.row_number,
          status: m.status,
          error_message: m.error_message,
        })),
      });
      toast.success(`已回写 ${data?.updated ?? targets.length} 条到飞书`);
    } catch (e) {
      toast.error(`回写失败：${(e as Error).message}`);
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
        <div>
          <h2 className="text-xl font-semibold tracking-tight">执行授权</h2>
          <p className="text-sm text-muted-foreground mt-1">
            从飞书拉取未授权素材，匹配广告户后批量授权并回写。
          </p>
        </div>
        <Button onClick={handleFetch} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4 mr-1.5", loading && "animate-spin")} />
          获取未授权素材
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              待授权账户{" "}
              <span className="text-xs font-normal text-muted-foreground ml-1">
                （本次匹配 {pendingAccounts.length} 个国家）
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">国家</TableHead>
                    <TableHead>广告户名称</TableHead>
                    <TableHead>广告户ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingAccounts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-20 text-center text-sm text-muted-foreground">
                        点击「获取未授权素材」后此处显示匹配到的广告户
                      </TableCell>
                    </TableRow>
                  ) : (
                    pendingAccounts.map((p) => (
                      <TableRow key={p.country}>
                        <TableCell>{p.country}</TableCell>
                        <TableCell>{p.advertiser_name}</TableCell>
                        <TableCell className="font-mono text-xs">{p.advertiser_id}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              抓取数据统计{" "}
              {totalWarning > 0 && (
                <span className="ml-1 inline-flex items-center gap-1 text-xs font-normal text-red-600">
                  <AlertTriangle className="h-3 w-3" />
                  {totalWarning} 条警告
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>人员姓名</TableHead>
                    <TableHead>国家</TableHead>
                    <TableHead className="text-right">待授权素材数</TableHead>
                    <TableHead className="text-right">警告素材数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-20 text-center text-sm text-muted-foreground">
                        暂无数据
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {stats.map((s) => (
                        <TableRow key={`${s.staff_name}-${s.country}`}>
                          <TableCell>{s.staff_name}</TableCell>
                          <TableCell>{s.country}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.pending}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", s.warning > 0 && "text-red-600 font-medium")}>
                            {s.warning}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/40 font-medium">
                        <TableCell colSpan={2}>合计</TableCell>
                        <TableCell className="text-right tabular-nums">{totalPending}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", totalWarning > 0 && "text-red-600")}>
                          {totalWarning}
                        </TableCell>
                      </TableRow>
                    </>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="text-base">
            素材列表{" "}
            <span className="text-xs font-normal text-muted-foreground ml-1">
              （共 {visibleMaterials.length} / {materials.length} 条）
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <MultiSelect
                label="人员姓名"
                options={staff.map((s) => s.name)}
                value={fStaff}
                onChange={setFStaff}
              />
              <MultiSelect
                label="国家"
                options={countriesInData}
                value={fCountry}
                onChange={setFCountry}
              />
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">VID</span>
                <Input
                  value={fVid}
                  onChange={(e) => setFVid(e.target.value)}
                  placeholder="模糊搜索"
                  className="h-8 w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">授权码</span>
                <Input
                  value={fAuth}
                  onChange={(e) => setFAuth(e.target.value)}
                  placeholder="模糊搜索"
                  className="h-8 w-40"
                />
              </div>
              <MultiSelect
                label="状态"
                options={ALL_STATUSES}
                value={fStatus}
                onChange={setFStatus}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" onClick={handleAuthorize}>
                <Send className="h-4 w-4 mr-1.5" />
                执行授权
              </Button>
              <Button size="sm" variant="outline" onClick={handleWriteback}>
                <Upload className="h-4 w-4 mr-1.5" />
                回写飞书表
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-1.5" />
                下载到 Excel
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>人员姓名</TableHead>
                  <TableHead>登记日期</TableHead>
                  <TableHead>国家</TableHead>
                  <TableHead>达人名称</TableHead>
                  <TableHead>VID</TableHead>
                  <TableHead>授权码</TableHead>
                  <TableHead>产品</TableHead>
                  <TableHead>广告户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>错误信息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMaterials.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                      暂无素材数据
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleMaterials.map((m) => (
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
  return (
    <TableRow className={cn(isWarn && "bg-red-50/60 hover:bg-red-50")}>
      <TableCell className="whitespace-nowrap">{m.staff_name}</TableCell>
      <TableCell className="whitespace-nowrap text-xs">{m.register_date}</TableCell>
      <TableCell>
        {isWarn ? (
          <Select value="" onValueChange={onAssignCountry}>
            <SelectTrigger className="h-7 w-28 text-xs">
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
      <TableCell className="whitespace-nowrap">{m.creator_name}</TableCell>
      <TableCell className="font-mono text-xs">{m.vid}</TableCell>
      <TableCell className="font-mono text-xs max-w-[160px] truncate" title={m.auth_code}>
        {m.auth_code}
      </TableCell>
      <TableCell className="whitespace-nowrap">{m.product}</TableCell>
      <TableCell className="text-xs">
        {m.advertiser_name ? (
          <>
            <div>{m.advertiser_name}</div>
            <div className="text-muted-foreground font-mono">{m.advertiser_id}</div>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={m.status as MaterialStatus} />
      </TableCell>
      <TableCell className="text-xs text-red-600 max-w-[200px] truncate" title={m.error_message}>
        {m.error_message ?? ""}
      </TableCell>
    </TableRow>
  );
}
