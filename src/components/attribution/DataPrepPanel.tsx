// 数据准备进度：把「同步达人登记 / GMV 目标 / 站点交接」三块基础数据的现状摊在页面上，
// 不用去飞书或数据库里翻，就能知道同步到什么程度、哪个人哪个站点是空的。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RotateCw, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import {
  type HandoverRow,
  type RegistryMatrixRow,
  type StaffRow,
  type TargetRow,
  dataPrepApi,
  fmtUsd,
} from "@/lib/attributionApi";

/** 站点固定顺序：没有数据也占位，一眼看出谁在哪个站点还没登记。 */
const COUNTRY_ORDER = ["PH", "TH", "VN", "MY", "SG", "PH2", "PHL", "MX-AR", "MX-NE", "MX-SJ", "US", "JP"];

type Data = {
  matrix: RegistryMatrixRow[];
  staff: StaffRow[];
  targets: TargetRow[];
  handovers: HandoverRow[];
};

export function DataPrepPanel({ month }: { month: string }) {
  const [data, setData] = React.useState<Data | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [m, t, h] = await Promise.all([
        dataPrepApi.registryMatrix(),
        dataPrepApi.targets(month),
        dataPrepApi.handovers(),
      ]);
      setData({ matrix: m.rows ?? [], staff: m.staff ?? [], targets: t.targets ?? [], handovers: h.handovers ?? [] });
    } catch (e) {
      toast.error(`加载数据准备进度失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [month]);

  // 站点列 = 固定顺序 + 数据里出现过的其它站点（排在后面，方便发现写错的站点）
  const countries = React.useMemo(() => {
    const extra = new Set<string>();
    for (const r of data?.matrix ?? []) {
      if (r.country && !COUNTRY_ORDER.includes(r.country)) extra.add(r.country);
    }
    return [...COUNTRY_ORDER, ...Array.from(extra).sort()];
  }, [data]);

  // 一人一行：把矩阵按 (同事, 站点) 索引起来
  const byStaff = React.useMemo(() => {
    const m = new Map<string, { role: string; active: boolean; cells: Map<string, RegistryMatrixRow>; vids: number; creators: number }>();
    for (const s of data?.staff ?? []) {
      m.set(s.name, { role: s.role, active: s.active, cells: new Map(), vids: 0, creators: 0 });
    }
    for (const r of data?.matrix ?? []) {
      let e = m.get(r.staff_name);
      if (!e) {
        // 登记表里有、但人员表里没有的（多半是离职后从人员表删掉了），也要显示出来
        e = { role: r.role, active: false, cells: new Map(), vids: 0, creators: 0 };
        m.set(r.staff_name, e);
      }
      e.cells.set(r.country, r);
      e.vids += r.vids;
      e.creators += r.creators;
    }
    return Array.from(m.entries())
      .filter(([, e]) => e.vids > 0 || e.creators > 0 || e.active)
      .sort((a, b) => b[1].vids - a[1].vids);
  }, [data]);

  const targetsByRole = React.useMemo(() => {
    const bd = (data?.targets ?? []).filter((t) => t.role !== "EDITOR");
    const ed = (data?.targets ?? []).filter((t) => t.role === "EDITOR");
    return { bd, ed, total: (data?.targets ?? []).reduce((n, t) => n + Number(t.target_usd || 0), 0) };
  }, [data]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">数据准备进度</CardTitle>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            {data ? "刷新" : "查看"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          三块基础数据同步到什么程度：达人登记（一人一行 × 站点，格子是「归因VID数 / 达人数」，都已去重）、
          当月 GMV 目标、站点交接记录。
        </p>
      </CardHeader>
      {data ? (
        <CardContent>
          <Tabs defaultValue="registry">
            <TabsList>
              <TabsTrigger value="registry">达人登记</TabsTrigger>
              <TabsTrigger value="targets">GMV 目标（{month}）</TabsTrigger>
              <TabsTrigger value="handovers">站点交接</TabsTrigger>
            </TabsList>

            <TabsContent value="registry" className="mt-3">
              <div className="border rounded-md overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky left-0 bg-background whitespace-nowrap">同事</TableHead>
                      <TableHead className="whitespace-nowrap">角色</TableHead>
                      <TableHead className="whitespace-nowrap">状态</TableHead>
                      <TableHead className="text-right whitespace-nowrap">合计 VID / 达人</TableHead>
                      {countries.map((c) => (
                        <TableHead key={c} className="text-right whitespace-nowrap">{c}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byStaff.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={countries.length + 4} className="h-16 text-center text-sm text-muted-foreground">
                          还没有达人登记数据，先点「同步达人登记」
                        </TableCell>
                      </TableRow>
                    ) : (
                      byStaff.map(([name, e]) => (
                        <TableRow key={name}>
                          <TableCell className="sticky left-0 bg-background font-medium whitespace-nowrap">{name}</TableCell>
                          <TableCell>
                            <Badge variant={e.role === "BD" ? "default" : "secondary"}>
                              {e.role === "BD" ? "BD" : "剪辑"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{e.active ? "在职" : "已离职"}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-semibold whitespace-nowrap">
                            {e.vids.toLocaleString()} / {e.creators.toLocaleString()}
                          </TableCell>
                          {countries.map((c) => {
                            const cell = e.cells.get(c);
                            return (
                              <TableCell key={c} className="text-right tabular-nums text-xs whitespace-nowrap">
                                {cell ? `${cell.vids} / ${cell.creators}` : <span className="text-muted-foreground">—</span>}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                格子含义：「该同事在该站点登记过的去重 VID 数 / 去重达人昵称数」。站点列固定顺序，没数据也占位。
              </div>
            </TabsContent>

            <TabsContent value="targets" className="mt-3 space-y-3">
              <div className="text-xs text-muted-foreground">
                {month} 共 {data.targets.length} 条目标，合计 ${fmtUsd(targetsByRole.total)}。
                目标只决定进度条分母，不影响归因结果；改飞书「绩效配置表」后点「同步 GMV 目标」。
              </div>
              {data.targets.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  {month} 还没有目标数据，点「同步 GMV 目标」从飞书拉取
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {[
                    { label: "BD", rows: targetsByRole.bd },
                    { label: "剪辑", rows: targetsByRole.ed },
                  ].map((g) => (
                    <div key={g.label} className="border rounded-md overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{g.label}</TableHead>
                            <TableHead className="text-right">目标（USD）</TableHead>
                            <TableHead>备注</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {g.rows.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={3} className="h-12 text-center text-xs text-muted-foreground">无</TableCell>
                            </TableRow>
                          ) : (
                            g.rows.map((t, i) => (
                              <TableRow key={`${t.staff_name}-${i}`}>
                                <TableCell className="text-xs font-medium">{t.staff_name}</TableCell>
                                <TableCell className="text-right tabular-nums text-xs">${fmtUsd(t.target_usd)}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{t.note || "—"}</TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="handovers" className="mt-3 space-y-2">
              <div className="text-xs text-muted-foreground">
                共 {data.handovers.length} 条交接记录。归因时按视频发布时间分段：交接日之前算原 BD，之后算新 BD。
              </div>
              {data.handovers.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  还没有交接记录，点「同步站点交接」从飞书拉取
                </div>
              ) : (
                <div className="border rounded-md overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>站点</TableHead>
                        <TableHead>交接</TableHead>
                        <TableHead>交接日期</TableHead>
                        <TableHead>备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.handovers.map((h, i) => (
                        <TableRow key={`${h.country}-${h.handover_date}-${i}`}>
                          <TableCell className="text-xs font-medium">{h.country}</TableCell>
                          <TableCell className="text-xs">
                            <span className="inline-flex items-center gap-1">
                              {h.from_bd}
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                              {h.to_bd}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">{h.handover_date}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{h.note || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      ) : null}
    </Card>
  );
}
