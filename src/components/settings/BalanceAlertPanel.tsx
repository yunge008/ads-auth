// 设置 → 账户余额预警：全局预警天数 X + 每户开关；显示可用余额 / 近10天正常日均 / 可用天数。
// 计算在 Edge Function `balance-alert`；飞书发送走服务端路由 /api/public/hooks/balance-alert-cron
// （FEISHU_BOT_WEBHOOK，与每日自动授权通知同一个群）。这里只做展示与触发。
import * as React from "react";
import { Bell, RotateCw, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { callEcoRoute, getAdminName, getPasscode, invokeFn } from "@/lib/api";
import { EcoVerifyButton } from "@/components/settings/EcoVerifyButton";
import { parseTargetDays, planRow, summarize, type PlanRow } from "@/lib/rechargePlan";

type Daily = {
  date: string;
  spend: number;
  valid: boolean;
  basic: number | null;
  gmv_max: number | null;
};
type AccountRow = {
  advertiser_id: string;
  advertiser_name: string | null;
  country: string | null;
  connections: string[];
  enabled: boolean;
  currency: string | null;
  balance: number | null;
  balance_source: string | null;
  avg_daily_spend: number | null;
  valid_days: number | null;
  window_start: string | null;
  window_end: string | null;
  daily: Daily[] | null;
  days_left: number | null;
  error: string | null;
  checked_at: string | null;
  last_alerted_at: string | null;
};
type Settings = {
  threshold_days: number;
  abnormal_ratio: number;
  feishu_chat_id: string | null;
  feishu_chat_name: string | null;
  last_run_at: string | null;
};

const fmt = (n: number | null | undefined, d = 2) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

export function BalanceAlertPanel() {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [accounts, setAccounts] = React.useState<AccountRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [xInput, setXInput] = React.useState("");
  const [ratioInput, setRatioInput] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [ecoReloadKey, setEcoReloadKey] = React.useState(0);
  // 充值计划（只在页面算）：目标可用天数 + 逐户改写的充值金额
  const [planDaysInput, setPlanDaysInput] = React.useState("");
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await invokeFn<{ settings: Settings; accounts: AccountRow[] }>("balance-alert", {
        action: "list",
      });
      setSettings(r.settings);
      setAccounts(r.accounts ?? []);
      setXInput(String(r.settings.threshold_days));
      setRatioInput(String(Math.round(r.settings.abnormal_ratio * 100)));
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    reload();
  }, [reload]);

  const saveSettings = async (patch: Record<string, unknown>) => {
    try {
      const r = await invokeFn<{ settings: Settings }>("balance-alert", {
        action: "save_settings",
        ...patch,
      });
      setSettings(r.settings);
      toast.success("已保存");
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    }
  };

  const refresh = async () => {
    let remaining: string[] | undefined;
    let done = 0;
    const failed: string[] = [];
    try {
      // 先同步 ECO 余额（只能走服务端路由，Supabase 出口被 ECO 拦截）；失败不阻断，行内会注明
      setRefreshing("同步 ECO 余额…");
      try {
        const eco = await callEcoRoute<{ ok: boolean; count: number; error?: string }>({
          action: "sync",
        });
        if (!eco.ok) toast.error(`ECO 余额同步失败：${eco.error ?? ""}`);
      } catch (e) {
        toast.error(`ECO 余额同步失败：${(e as Error).message}`);
      }
      for (let round = 0; round < 30; round++) {
        setRefreshing(`拉取中…已完成 ${done}`);
        const r = await invokeFn<{
          done: number;
          remaining: string[];
          failed: Array<{ advertiser_id: string }>;
          balance_errors: string[];
        }>(
          "balance-alert",
          { action: "refresh", ...(remaining ? { advertiser_ids: remaining } : {}) },
          { timeout: 150_000 },
        );
        done += r.done;
        failed.push(...(r.failed ?? []).map((f) => f.advertiser_id));
        if (r.balance_errors?.length) console.warn("balance errors", r.balance_errors);
        remaining = r.remaining;
        if (!remaining?.length) break;
      }
      toast.success(
        `已刷新 ${done} 个账户${failed.length ? `，${failed.length} 个有缺数（见行内提示）` : ""}`,
      );
    } catch (e) {
      toast.error(`刷新失败：${(e as Error).message}`);
    } finally {
      setRefreshing(null);
      setEcoReloadKey((k) => k + 1);
      reload();
    }
  };

  const notify = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/public/hooks/balance-alert-cron", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-passcode": getPasscode(),
          "x-admin-name": encodeURIComponent(getAdminName()),
        },
        body: JSON.stringify({ manual: true }),
      });
      const r = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        alerts?: number;
      };
      if (!res.ok || !r.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
      toast.success(`已发送到飞书授权通知群（预警 ${r.alerts ?? 0} 个）`);
    } catch (e) {
      toast.error(`发送失败：${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setAccounts((prev) => prev.map((a) => (a.advertiser_id === id ? { ...a, enabled } : a)));
    try {
      await invokeFn("balance-alert", { action: "toggle", advertiser_id: id, enabled });
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
      reload();
    }
  };

  const X = settings?.threshold_days ?? 3;
  const q = filter.trim().toLowerCase();
  const rows = [...accounts]
    .filter(
      (a) =>
        !q ||
        [a.advertiser_id, a.advertiser_name, a.country, ...a.connections].some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(q),
        ),
    )
    // 按近10天正常日均倒序（没有日均的排最后）
    .sort((a, b) => (b.avg_daily_spend ?? -1) - (a.avg_daily_spend ?? -1));
  const T = parseTargetDays(planDaysInput);
  const planInputs = rows.map((a) => ({
    id: a.advertiser_id,
    enabled: a.enabled,
    balance: a.balance,
    avg: a.avg_daily_spend,
    daysLeft: a.days_left,
  }));
  const plan = new Map<string, PlanRow>(
    planInputs.map((p) => {
      const o = overrides[p.id];
      const ov = o != null && o.trim() !== "" && Number.isFinite(Number(o)) ? Number(o) : null;
      return [p.id, planRow(p, T, ov)];
    }),
  );
  const summary = summarize(planInputs, plan);
  const alertCount = accounts.filter(
    (a) => a.enabled && a.days_left != null && a.days_left < X,
  ).length;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4" />
            账户余额预警
            {alertCount > 0 && (
              <Badge variant="destructive">
                {alertCount} 个不足 {X} 天
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            可用天数 = 可用余额 ÷ 近 10 个完整自然日（北京日期，不含今天）的<b>正常日均</b>。日耗为
            0、或低于这 10 天正日耗中位数 × {Math.round((settings?.abnormal_ratio ?? 0.3) * 100)}%
            的天 视为没开 / 学习期，不计入日均。每天北京 10:00
            自动刷新，并把所有开了监控的账户列表发到飞书授权通知群（与每日自动授权通知同一个群）。
            可用天数标红 = 已低于 X 天，标黄 = 距离 X 天不足 5 天。近 10 天日耗全为 0 的账户即使余额
            ≤0 也不预警。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">预警天数 X（统一）</span>
              <div className="flex gap-1">
                <Input
                  value={xInput}
                  onChange={(e) => setXInput(e.target.value)}
                  className="h-8 w-20"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveSettings({ threshold_days: Number(xInput) })}
                >
                  <Save className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">异常日阈值（中位数的 %）</span>
              <div className="flex gap-1">
                <Input
                  value={ratioInput}
                  onChange={(e) => setRatioInput(e.target.value)}
                  className="h-8 w-20"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveSettings({ abnormal_ratio: Number(ratioInput) / 100 })}
                >
                  <Save className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <EcoVerifyButton reloadKey={ecoReloadKey} onVerified={reload} />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">充值可用天数（页面试算）</span>
              <div className="flex items-center gap-2">
                <Input
                  value={planDaysInput}
                  onChange={(e) => {
                    setPlanDaysInput(e.target.value);
                    setOverrides({});
                  }}
                  placeholder="如 20"
                  className="h-8 w-20"
                />
                {T != null && (
                  <span className="text-xs whitespace-nowrap">
                    {T} 天缺口 <b>{fmt(summary.gap)}</b>，计划充值{" "}
                    <b className="text-primary">{fmt(summary.recharge, 0)}</b>
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2 ml-auto">
              <Input
                placeholder="搜索账户/ID/国家"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 w-44"
              />
              <Button size="sm" variant="outline" onClick={refresh} disabled={!!refreshing}>
                <RotateCw className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ?? "立即刷新"}
              </Button>
              <Button size="sm" onClick={notify} disabled={sending}>
                <Send className="h-4 w-4 mr-1.5" />
                发送到飞书
              </Button>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            上次全量刷新：
            {settings?.last_run_at ? new Date(settings.last_run_at).toLocaleString() : "从未"} · 共{" "}
            {accounts.length} 个已授权账户
          </div>

          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>预警</TableHead>
                  <TableHead>账户</TableHead>
                  <TableHead>国家</TableHead>
                  <TableHead className="text-right">可用余额</TableHead>
                  <TableHead className="text-right whitespace-nowrap">
                    {T != null ? `推荐充值（${T}天）` : "推荐充值"}
                  </TableHead>
                  <TableHead className="text-right">近10天正常日均</TableHead>
                  <TableHead className="text-right">正常天数</TableHead>
                  <TableHead className="text-right whitespace-nowrap">
                    {T != null ? "充值后可用天数" : "可用天数"}
                  </TableHead>
                  <TableHead>更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="h-16 text-center text-sm text-muted-foreground"
                    >
                      加载中…
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="h-16 text-center text-sm text-muted-foreground"
                    >
                      暂无已授权账户
                    </TableCell>
                  </TableRow>
                ) : (
                  [
                    <TableRow key="__summary" className="bg-muted/60 font-medium">
                      <TableCell />
                      <TableCell>汇总（已开预警 {summary.count} 户）</TableCell>
                      <TableCell />
                      <TableCell className="text-right">{fmt(summary.balance)}</TableCell>
                      <TableCell className="text-right text-primary">
                        {T != null ? fmt(summary.recharge, 0) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{fmt(summary.avg)}</TableCell>
                      <TableCell />
                      <TableCell className="text-right">
                        <span
                          title={`加权：(Σ余额+Σ计划充值)÷Σ日耗；各户简单平均 ${fmt(summary.meanDays, 1)} 天`}
                        >
                          {fmt(summary.weightedDays, 1)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        可用天数为加权平均
                      </TableCell>
                    </TableRow>,
                    ...rows.map((a) => {
                      const pr = plan.get(a.advertiser_id);
                      const shownDays = pr?.days ?? a.days_left;
                      const low = shownDays != null && shownDays < X;
                      // 红：已达监控天数（< X）；黄：距离监控天数 5 天内（X ~ X+5）
                      const near = shownDays != null && !low && shownDays < X + 5;
                      return (
                        <TableRow
                          key={a.advertiser_id}
                          className={low && a.enabled ? "bg-destructive/5" : undefined}
                        >
                          <TableCell>
                            <Switch
                              checked={a.enabled}
                              onCheckedChange={(v) => toggle(a.advertiser_id, v)}
                            />
                          </TableCell>
                          <TableCell className="max-w-[260px]">
                            <div className="font-medium truncate">
                              {a.advertiser_name ?? a.advertiser_id}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {a.advertiser_id} · {a.connections.join("/")}
                            </div>
                            {a.error && (
                              <div className="text-xs text-amber-600 truncate" title={a.error}>
                                ⚠ {a.error}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>{a.country ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            <span title={a.balance_source ?? ""}>{fmt(a.balance)}</span>
                            <span className="text-xs text-muted-foreground ml-1">
                              {a.currency ?? ""}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {T != null && pr?.eligible ? (
                              <Input
                                value={overrides[a.advertiser_id] ?? String(pr.recommended)}
                                onChange={(e) =>
                                  setOverrides((o) => ({ ...o, [a.advertiser_id]: e.target.value }))
                                }
                                title={`缺口 ${fmt(pr.gap)}，按 100 向上取整推荐 ${fmt(pr.recommended, 0)}`}
                                className="h-7 w-24 ml-auto text-right"
                              />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {a.daily ? (
                              <Tooltip>
                                <TooltipTrigger className="underline decoration-dotted">
                                  {fmt(a.avg_daily_spend)}
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">
                                  {a.daily.map((d) => (
                                    <div
                                      key={d.date}
                                      className={d.valid ? "" : "opacity-50 line-through"}
                                    >
                                      {d.date}：{fmt(d.spend)}
                                      {d.gmv_max != null
                                        ? `（BASIC ${fmt(d.basic)} / GMV Max ${fmt(d.gmv_max)}）`
                                        : ""}
                                    </div>
                                  ))}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {a.valid_days == null ? "—" : `${a.valid_days}/10`}
                          </TableCell>
                          <TableCell
                            className={`text-right font-medium ${low ? "text-destructive" : near ? "text-amber-600" : ""}`}
                          >
                            {shownDays == null ? (
                              "—"
                            ) : (
                              <span
                                className={`inline-block rounded px-1.5 py-0.5 ${low ? "bg-red-100 dark:bg-red-950" : near ? "bg-yellow-100 dark:bg-yellow-950" : ""}`}
                              >
                                {fmt(shownDays, 1)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {a.checked_at ? new Date(a.checked_at).toLocaleString() : "未刷新"}
                          </TableCell>
                        </TableRow>
                      );
                    }),
                  ]
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
