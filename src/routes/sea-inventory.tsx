import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, Loader2, Play, RefreshCw, Send, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getAdminName, getPasscode } from "@/lib/api";
import { matchWarehouse, parseUploadFile, type UpGroup } from "@/lib/stockUpload";
import {
  type MapRow, type Overview, type PlanItem, type PlanRow,
  type SeaShop, type SeaWarehouse, seaApi, type WhLink, sendPlanToFeishu, type StockRow,
} from "@/lib/seaInventoryApi";

export const Route = createFileRoute("/sea-inventory")({
  head: () => ({ meta: [{ title: "SEA库存监控 - TikTok授权工具" }] }),
  component: SeaInventoryPage,
});

const bj = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
const ageH = (iso: string | null | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 3600_000 : Infinity);
const fmtDays = (d: number | null) => (d === null || d === undefined ? "无销量" : Number(d).toFixed(1));
const dayCls = (d: number | null) =>
  d === null ? "text-muted-foreground" : d < 3 ? "text-red-600 font-semibold" : d < 7 ? "text-orange-600 font-semibold" : "text-amber-600";

const STATUS_LABEL: Record<string, string> = { active: "使用中", onboarding: "新仓接入中", phasing_out: "逐步退出", disabled: "停用" };
const PROVIDER_LABEL: Record<string, string> = { qianyi: "千易 ERP API", dingmiao: "顶妙WMS API", bigseller: "BigSeller（无 API，手动导入）", manual: "手动导入", tiktok: "仅 TikTok（无实物库存）" };
const EXEC_STYLE: Record<string, string> = { OK: "bg-green-600 text-white", FAILED: "bg-red-600 text-white", SKIPPED: "bg-slate-400 text-white", PENDING: "" };
const PLAN_STATUS: Record<string, string> = { PENDING: "待确认", EXECUTING: "执行中", DONE: "已执行", PARTIAL: "部分执行", FAILED: "失败", SUPERSEDED: "已被新计划替代" };

function SeaInventoryPage() {
  const [ov, setOv] = React.useState<Overview | null>(null);
  const load = React.useCallback(async () => {
    try { setOv(await seaApi.overview()); } catch (e) { toast.error(`读取失败：${(e as Error).message}`); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">SEA库存监控</h2>
        <p className="text-sm text-muted-foreground mt-1">
          海外仓库存按销量分配到各 listing，国内仓按可售天数补货。每天北京 09:10 / 21:10 自动生成计划并推送飞书。<b>目前只给调整建议，导出清单后人工修改，系统不会自动改库存</b>。
        </p>
      </div>
      <Tabs defaultValue="plan">
        <TabsList>
          <TabsTrigger value="plan">调整计划</TabsTrigger>
          <TabsTrigger value="warehouses">仓库与库存</TabsTrigger>
          <TabsTrigger value="map">SKU 映射表</TabsTrigger>
          <TabsTrigger value="settings">参数</TabsTrigger>
        </TabsList>
        <TabsContent value="plan">{ov ? <PlanPanel ov={ov} reload={load} /> : <Loading />}</TabsContent>
        <TabsContent value="warehouses">{ov ? <WarehousePanel ov={ov} reload={load} /> : <Loading />}</TabsContent>
        <TabsContent value="map">{ov ? <MapPanel ov={ov} /> : <Loading />}</TabsContent>
        <TabsContent value="settings">{ov ? <SettingsPanel ov={ov} reload={load} /> : <Loading />}</TabsContent>
      </Tabs>
    </div>
  );
}

function Loading() {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground p-6"><Loader2 className="h-4 w-4 animate-spin" />读取中…</div>;
}

// ═══ 调整计划 ═══════════════════════════════════════════════════════════════
// ── 「同步并生成计划」任务：放在组件外，组件卸载（切 TAB / 换页面）不影响运行与进度 ──
type GenJob = { running: boolean; msg: string; seq: number; planId: string | null };
let genJob: GenJob = { running: false, msg: "", seq: 0, planId: null };
const genSubs = new Set<() => void>();
const setGenJob = (p: Partial<GenJob>) => { genJob = { ...genJob, ...p }; genSubs.forEach((f) => f()); };
function useGenJob(): GenJob {
  return React.useSyncExternalStore(
    (cb) => { genSubs.add(cb); return () => { genSubs.delete(cb); }; },
    () => genJob,
    () => genJob,
  );
}
async function runGenerate(shops: string[], shopName: (id: string) => string) {
  if (genJob.running) return;
  setGenJob({ running: true, msg: "开始同步…", planId: null });
  try {
    for (const sid of shops) {
      let cursor: unknown = null, n = 0;
      do {
        setGenJob({ msg: `同步店铺 ${shopName(sid)}（第 ${++n} 段，首次会拉近 60 天订单）…` });
        const r = await seaApi.syncShop(sid, cursor);
        cursor = r.done ? null : r.cursor;
      } while (cursor);
    }
    setGenJob({ msg: "生成计划…" });
    const r = await seaApi.buildPlan();
    toast.success(`已生成：海外仓调整 ${r.summary.overseas} 条、国内仓预警 ${r.summary.cn} 条${r.warnings.length ? `，${r.warnings.length} 条数据提示` : ""}`);
    setGenJob({ running: false, msg: "", planId: r.plan_id, seq: genJob.seq + 1 });
  } catch (e) {
    toast.error((e as Error).message);
    setGenJob({ running: false, msg: "", seq: genJob.seq + 1 });
  }
}

function PlanPanel({ ov, reload }: { ov: Overview; reload: () => Promise<void> }) {
  const [planId, setPlanId] = React.useState<string | undefined>(ov.plans[0]?.id);
  const [plan, setPlan] = React.useState<PlanRow | null>(null);
  const [items, setItems] = React.useState<PlanItem[]>([]);
  const [shops, setShops] = React.useState<SeaShop[]>([]);
  const [busy, setBusy] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const loadPlan = React.useCallback(async (id?: string) => {
    if (!id) { setPlan(null); setItems([]); return; }
    try {
      const r = await seaApi.planGet(id);
      setPlan(r.plan); setItems(r.items); setShops(r.shops);
    } catch (e) { toast.error(`读取计划失败：${(e as Error).message}`); }
  }, []);
  React.useEffect(() => { void loadPlan(planId); }, [planId, loadPlan]);

  const shopName = (id: string) => { const s = shops.find((x) => x.shop_id === id) ?? ov.shops.find((x) => x.shop_id === id); return s ? `${s.region ?? ""} ${s.shop_name ?? id}` : id; };
  const whName = (code: string) => ov.warehouses.find((w) => w.code === code)?.name ?? code;
  const editable = plan && ["PENDING", "PARTIAL"].includes(plan.status);

  // 同步任务在组件外运行（genJob），切换 TAB / 离开页面再回来进度都在；跑完自动载入新计划
  const job = useGenJob();
  const seenSeq = React.useRef(job.seq);
  React.useEffect(() => {
    if (job.seq === seenSeq.current || job.running) return;
    seenSeq.current = job.seq;
    if (job.planId) { void reload(); setPlanId(job.planId); void loadPlan(job.planId); }
  }, [job.seq, job.running, job.planId, reload, loadPlan]);
  const generate = () => runGenerate(ov.linked_shops, shopName);

  async function patch(it: PlanItem, p: { selected?: boolean; final_qty?: number | null }) {
    if (!plan) return;
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, ...p } : x)));
    try { await seaApi.planUpdate(plan.id, [{ id: it.id, ...p }]); } catch (e) { toast.error((e as Error).message); void loadPlan(plan.id); }
  }
  async function setAll(kind: "overseas" | "cn", selected: boolean) {
    if (!plan) return;
    const ids = items.filter((i) => i.kind === kind && i.exec_status === "PENDING").map((i) => i.id);
    setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, selected } : x)));
    try { await seaApi.planUpdate(plan.id, ids.map((id) => ({ id, selected }))); } catch (e) { toast.error((e as Error).message); }
  }

  const toRun = items.filter((i) => i.selected && i.exec_status === "PENDING");
  async function run() {
    if (!plan) return;
    setConfirmOpen(false);
    let tot = { ok: 0, failed: 0, skipped: 0 };
    try {
      let remaining = 0, n = 0;
      do {
        setBusy(`执行中（第 ${++n} 批）…`);
        const r = await seaApi.execute(plan.id, toRun.map((i) => i.id));
        tot = { ok: tot.ok + r.ok, failed: tot.failed + r.failed, skipped: tot.skipped + r.skipped };
        remaining = r.remaining;
      } while (remaining > 0 && n < 20);
      (tot.failed ? toast.warning : toast.success)(`执行完成：成功 ${tot.ok}，失败 ${tot.failed}，跳过 ${tot.skipped}`);
    } catch (e) { toast.error((e as Error).message); } finally {
      setBusy(""); await loadPlan(plan.id); await reload();
    }
  }

  function exportPlan() {
    if (!plan) return;
    const head = ["类型", "店铺", "仓库", "商家SKU", "SKU ID", "商品ID", "TikTok仓库ID", "日销", "当前可售", "建议数量", "可售天数(前)", "可售天数(后)", "仓库可用", "可分配", "原因", "提示", "勾选"];
    const rows = items.map((i) => [
      i.kind === "cn" ? "国内仓预警（人工）" : "海外仓", shopName(i.shop_id), whName(i.warehouse_code), i.seller_sku ?? "", i.sku_id, i.product_id, i.tts_warehouse_id,
      i.daily_sales, i.current_qty, i.final_qty ?? i.proposed_qty, i.days_before ?? "无销量", i.days_after ?? "无销量",
      i.wh_available ?? "", i.pool ?? "", i.reason ?? "", (i.warnings ?? []).join("；"), i.selected ? "是" : "否",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    ws["!cols"] = head.map((h) => ({ wch: ["原因", "提示"].includes(h) ? 50 : ["SKU ID", "商品ID", "TikTok仓库ID"].includes(h) ? 22 : 12 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "调整清单");
    const t = new Date(plan.created_at).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[-: ]/g, "").slice(0, 12);
    XLSX.writeFile(wb, `SEA库存调整清单_${t}.xlsx`);
  }

  async function feishu() {
    if (!plan) return;
    setBusy("发送飞书…");
    try { await sendPlanToFeishu(plan.id, getPasscode(), getAdminName()); toast.success("已发送到飞书群"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  const ovItems = items.filter((i) => i.kind === "overseas");
  const cnItems = items.filter((i) => i.kind === "cn");
  const notConfigured = !ov.linked_shops.length;

  return (
    <div className="space-y-4 mt-3">
      {notConfigured && (
        <Card className="border-amber-300 bg-amber-50"><CardContent className="p-4 text-sm">
          还没有给任何仓库绑定 TikTok 店铺仓库。请先到「仓库与库存」给每个仓库添加绑定（店铺 + TikTok 仓库），并导入/同步海外仓库存；定时任务在配置前不会运行。
        </CardContent></Card>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={!!busy || job.running || notConfigured}><RefreshCw className="h-4 w-4 mr-1" />同步并生成计划</Button>
        <select className="h-9 rounded-md border px-2 text-sm" value={planId ?? ""} onChange={(e) => setPlanId(e.target.value || undefined)}>
          {ov.plans.map((p) => <option key={p.id} value={p.id}>{bj(p.created_at)} · {p.source === "CRON" ? "定时" : "手动"} · {PLAN_STATUS[p.status] ?? p.status}</option>)}
          {!ov.plans.length && <option value="">暂无计划</option>}
        </select>
        <Button variant="outline" onClick={feishu} disabled={!!busy || !plan}><Send className="h-4 w-4 mr-1" />发送到飞书</Button>
        <Button variant="outline" onClick={exportPlan} disabled={!!busy || !items.length}><Download className="h-4 w-4 mr-1" />导出调整清单</Button>
        {/* 一键改库存：初期隐藏，负责人确认后在 Supabase secrets 设 SEA_INV_EXEC_ENABLED=true 才显示 */}
        {ov.exec_enabled && (
          <Button onClick={() => setConfirmOpen(true)} disabled={!!busy || !editable || !toRun.length} className="bg-red-600 hover:bg-red-700">
            <Play className="h-4 w-4 mr-1" />确认执行所选（{toRun.length}）
          </Button>
        )}
        {(job.running || busy) && <span className="flex items-center gap-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{job.running ? job.msg : busy}</span>}
      </div>

      {plan && (
        <div className="text-sm text-muted-foreground">
          计划生成于 {bj(plan.created_at)}，状态 <b>{PLAN_STATUS[plan.status] ?? plan.status}</b>
          {plan.executed_at && <>；最近执行 {bj(plan.executed_at)}（{plan.executed_by}）</>}
          {ageH(plan.created_at) > 14 && editable && <span className="text-red-600">；计划已超过 14 小时，执行会被拒绝，请重新生成</span>}
        </div>
      )}
      {!!plan?.data_warnings?.length && (
        <Card className="border-red-300 bg-red-50"><CardContent className="p-3 text-sm space-y-1">
          {plan.data_warnings.map((w, i) => <div key={i} className="text-red-700">⚠ {w}</div>)}
        </CardContent></Card>
      )}
      {plan?.summary && Number(plan.summary.missing_in_warehouse ?? 0) > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-amber-700">{String(plan.summary.missing_in_warehouse)} 个 listing SKU 在对应海外仓库存里找不到（编码不一致或仓库无货），未参与调整 —— 展开查看</summary>
          <div className="mt-2 max-h-60 overflow-auto text-xs font-mono">
            {((plan.summary.missing_sample as Array<{ warehouse_code: string; wh_sku: string; slots: number }>) ?? []).map((g, i) => (
              <div key={i}>{whName(g.warehouse_code)} · {g.wh_sku} · {g.slots} 个 listing</div>
            ))}
          </div>
        </details>
      )}

      <ItemTable title="海外仓" items={ovItems} editable={!!editable} shopName={shopName} whName={whName} onPatch={patch} onAll={(v) => setAll("overseas", v)} />
      <ItemTable title="国内仓预警" hint="仅预警，系统不改库存：确认国内仓有货（不足及时采购）后人工修改；「建议」= 补到国内仓目标天数" items={cnItems} editable={false} shopName={shopName} whName={whName} onPatch={patch} onAll={(v) => setAll("cn", v)} />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认修改 {toRun.length} 条 TikTok 库存？</AlertDialogTitle>
            <AlertDialogDescription>
              将调用 TikTok Shop「Update Inventory」直接修改线上 listing 库存（海外仓 {toRun.filter((i) => i.kind === "overseas").length} 条、国内仓 {toRun.filter((i) => i.kind === "cn").length} 条）。
              执行前会实时读一次库存：海外仓数量会扣掉计划生成后已卖出的件数；目标为 0 的不执行。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={run} className="bg-red-600 hover:bg-red-700">确认执行</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ItemTable({ title, hint, items, editable, shopName, whName, onPatch, onAll }: {
  title: string; hint?: string; items: PlanItem[]; editable: boolean; shopName: (id: string) => string; whName: (c: string) => string;
  onPatch: (it: PlanItem, p: { selected?: boolean; final_qty?: number | null }) => void; onAll: (v: boolean) => void;
}) {
  const skus = new Set(items.map((i) => i.wh_sku)).size;
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base flex items-center gap-3">
          {title}：{items.length} 条 / {skus} 个 SKU
          {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
          {editable && items.length > 0 && (
            <span className="ml-auto flex gap-2 text-xs font-normal">
              <Button size="sm" variant="ghost" onClick={() => onAll(true)}>全选</Button>
              <Button size="sm" variant="ghost" onClick={() => onAll(false)}>全不选</Button>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {!items.length ? <div className="p-4 text-sm text-muted-foreground">无需调整</div> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:whitespace-nowrap">
                <th></th><th>SKU</th><th>店铺</th><th>仓</th><th className="text-right">日销</th><th className="text-right">当前</th>
                <th className="text-right">建议</th><th className="text-right">可售天数</th><th>仓库可用/可分配</th><th>原因</th><th>执行</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t align-top [&>td]:px-2 [&>td]:py-1.5">
                  <td><Checkbox checked={it.selected} disabled={!editable || it.exec_status !== "PENDING"} onCheckedChange={(v) => onPatch(it, { selected: v === true })} /></td>
                  <td className="font-mono whitespace-nowrap" title={it.title ?? ""}>{it.seller_sku || it.sku_id}{it.new_link && <Badge className="ml-1" variant="secondary">新仓首次</Badge>}</td>
                  <td className="whitespace-nowrap">{shopName(it.shop_id)}</td>
                  <td className="whitespace-nowrap">{whName(it.warehouse_code)}</td>
                  <td className="text-right">{it.daily_sales}</td>
                  <td className="text-right">{it.current_qty}</td>
                  <td className="text-right">
                    {editable && it.exec_status === "PENDING" ? (
                      <Input type="number" className="h-7 w-20 px-1 text-right ml-auto" defaultValue={it.final_qty ?? it.proposed_qty}
                        onBlur={(e) => { const v = Number(e.target.value); if (v !== (it.final_qty ?? it.proposed_qty)) onPatch(it, { final_qty: v === it.proposed_qty ? null : v }); }} />
                    ) : <span>{it.exec_qty ?? it.final_qty ?? it.proposed_qty}</span>}
                    {it.final_qty !== null && <div className="text-[10px] text-muted-foreground">原建议 {it.proposed_qty}</div>}
                  </td>
                  <td className="text-right whitespace-nowrap"><span className={dayCls(it.days_before)}>{fmtDays(it.days_before)}</span> → {fmtDays(it.days_after)}</td>
                  <td className="whitespace-nowrap">{it.wh_available ?? "—"}{it.pool !== null && ` / ${it.pool}`}</td>
                  <td className="text-xs max-w-[280px]">{it.reason}{it.warnings.map((w, i) => <div key={i} className="text-amber-700">⚠ {w}</div>)}</td>
                  <td className="text-xs max-w-[220px]">
                    {it.exec_status !== "PENDING" && <Badge className={EXEC_STYLE[it.exec_status]}>{it.exec_status}</Badge>}
                    {it.exec_message && <div className="text-muted-foreground break-all">{it.exec_message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// ═══ 仓库与库存 ═════════════════════════════════════════════════════════════
// 一屏看完：上面「配对总览」矩阵（海外仓 × 店铺，绿=已配对），下面仓库小卡片（库存状态 + 同步/上传）。
// 国内仓不在这里：不绑定、不设库存，只在调整计划里预警（未绑定到海外仓的 TikTok 仓库都算国内仓）。
const REGION_STYLE: Record<string, { bar: string; chip: string }> = {
  PH: { bar: "bg-blue-500", chip: "bg-blue-100 text-blue-800" },
  MY: { bar: "bg-amber-500", chip: "bg-amber-100 text-amber-800" },
  TH: { bar: "bg-violet-500", chip: "bg-violet-100 text-violet-800" },
  VN: { bar: "bg-emerald-500", chip: "bg-emerald-100 text-emerald-800" },
};
const regionStyle = (r: string | null | undefined) => REGION_STYLE[(r ?? "").toUpperCase()] ?? { bar: "bg-slate-400", chip: "bg-slate-100 text-slate-700" };
type StockState = { tone: "ok" | "stale" | "none" | "off"; label: string };
function stockState(w: SeaWarehouse, maxAge: number): StockState {
  if (w.status === "disabled") return { tone: "off", label: "停用" };
  if (!w.stock_synced_at) return { tone: "none", label: "无库存数据" };
  if (ageH(w.stock_synced_at) > maxAge) return { tone: "stale", label: "库存过期" };
  return { tone: "ok", label: "库存正常" };
}
const TONE_DOT: Record<StockState["tone"], string> = { ok: "bg-green-500", stale: "bg-red-500", none: "bg-amber-400", off: "bg-slate-300" };
const shortTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");

function WarehousePanel({ ov, reload }: { ov: Overview; reload: () => Promise<void> }) {
  const whs = ov.warehouses.filter((w) => w.kind === "overseas");
  const active = whs.filter((w) => w.status !== "disabled");
  const bound = active.filter((w) => w.links.length > 0).length;
  const stale = active.filter((w) => stockState(w, ov.settings.stock_max_age_hours).tone !== "ok").length;
  return (
    <div className="space-y-3 mt-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-full bg-green-100 text-green-800 px-3 py-1">已配对 {bound} 个仓</span>
        <span className={`rounded-full px-3 py-1 ${active.length - bound ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-600"}`}>未配对 {active.length - bound}</span>
        <span className={`rounded-full px-3 py-1 ${stale ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-600"}`}>库存过期/缺失 {stale}</span>
        <span className="text-xs text-muted-foreground">库存超过 {ov.settings.stock_max_age_hours} 小时未更新的仓不参与调整；国内仓无需配对，只做预警</span>
      </div>
      <BindMatrix ov={ov} whs={whs} reload={reload} />
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {whs.map((w) => <StockTile key={w.code} w={w} maxAge={ov.settings.stock_max_age_hours} reload={reload} />)}
      </div>
    </div>
  );
}

/** 配对总览：行 = 海外仓，列 = 店铺。同站点才可配对；点格子绑定 / 解绑 */
function BindMatrix({ ov, whs, reload }: { ov: Overview; whs: SeaWarehouse[]; reload: () => Promise<void> }) {
  const shops = ov.shops;
  const sync = new Map(ov.shop_sync.map((x) => [x.shop_id, x]));
  if (!shops.length) return <Card><CardContent className="p-3 text-sm text-amber-700">还没有授权的 TikTok 店铺，先到「设置 → TikTok Shop 授权」授权</CardContent></Card>;
  return (
    <Card><CardContent className="p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40">
            <th className="text-left px-3 py-2 font-medium w-48">海外仓 \ 店铺</th>
            {shops.map((sh) => {
              const st = sync.get(sh.shop_id);
              return (
                <th key={sh.shop_id} className="px-2 py-2 font-normal text-center min-w-[120px]">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${regionStyle(sh.region).chip}`}>{sh.region}</span>
                  <div className="text-xs font-medium mt-0.5 truncate max-w-[140px] mx-auto" title={sh.shop_name ?? sh.shop_id}>{sh.shop_name ?? sh.shop_id}</div>
                  <div className={`text-[10px] ${st?.error ? "text-red-600" : "text-muted-foreground"}`} title={st?.error ?? ""}>
                    {st?.error ? "同步出错" : st?.orders_at ? `同步 ${shortTime(st.orders_at)}` : "未同步"}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {whs.map((w) => (
            <tr key={w.code} className={`border-t ${w.status === "disabled" ? "opacity-50" : ""}`}>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className={`w-1 h-8 rounded ${regionStyle(w.region).bar}`} />
                  <div>
                    <div className="font-medium leading-tight">{w.name}</div>
                    <div className="text-[10px] text-muted-foreground">{STATUS_LABEL[w.status]}</div>
                  </div>
                </div>
              </td>
              {shops.map((sh) => <BindCell key={sh.shop_id} w={w} shop={sh} reload={reload} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </CardContent></Card>
  );
}

function BindCell({ w, shop, reload }: { w: SeaWarehouse; shop: SeaShop; reload: () => Promise<void> }) {
  const links = w.links.filter((l) => l.shop_id === shop.shop_id);
  const sameRegion = !w.region || !shop.region || w.region.toUpperCase() === shop.region.toUpperCase();
  const [open, setOpen] = React.useState(false);
  const [opts, setOpts] = React.useState<Array<{ id: string; name?: string; type?: string }> | null>(null);
  const [pick, setPick] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const save = async (next: WhLink[]) => {
    setBusy(true);
    try { await seaApi.saveWarehouse({ code: w.code, links: next }); toast.success("已保存"); setOpen(false); await reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const onOpen = async (o: boolean) => {
    setOpen(o);
    if (!o || opts) return;
    try {
      const r = await seaApi.shopWarehouses(shop.shop_id);
      setOpts(r.warehouses);
      if (r.fallback) toast.warning(r.error ?? "读不到仓库名称，已改为从在售商品汇总仓库 ID", { duration: 10000 });
    } catch (e) { toast.error((e as Error).message); setOpts([]); }
  };
  if (!sameRegion && !links.length) return <td className="text-center text-slate-300">—</td>;
  return (
    <td className="px-2 py-1.5 text-center">
      <Popover open={open} onOpenChange={onOpen}>
        <PopoverTrigger asChild>
          {links.length ? (
            <button className="rounded-md bg-green-100 text-green-800 hover:bg-green-200 px-2 py-1 text-xs font-medium" title={links.map((l) => l.tts_warehouse_id).join("、")}>
              ✓ 已配对{links.length > 1 ? ` ×${links.length}` : ""} <span className="font-mono opacity-60">…{links[0].tts_warehouse_id.slice(-6)}</span>
            </button>
          ) : (
            <button className="rounded-md border border-dashed border-red-300 text-red-600 hover:bg-red-50 px-2 py-1 text-xs">+ 绑定</button>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-80 text-sm space-y-2">
          <div className="font-medium">{w.name} × {shop.region} {shop.shop_name}</div>
          {links.map((l) => (
            <div key={l.tts_warehouse_id} className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{l.tts_warehouse_id}</span>
              <Button size="sm" variant="ghost" className="text-red-600" disabled={busy}
                onClick={() => save(w.links.filter((x) => !(x.shop_id === shop.shop_id && x.tts_warehouse_id === l.tts_warehouse_id)))}>解绑</Button>
            </div>
          ))}
          {opts === null ? <div className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />读取店铺仓库…</div> : (
            <div className="flex items-center gap-2">
              <select className="h-8 flex-1 min-w-0 rounded-md border px-2 text-xs" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">选择 TikTok 仓库…</option>
                {opts.filter((x) => !links.some((l) => l.tts_warehouse_id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}{x.type ? `（${x.type}）` : ""}</option>)}
              </select>
              <Button size="sm" disabled={busy || !pick} onClick={() => save([...w.links, { shop_id: shop.shop_id, tts_warehouse_id: pick }])}>绑定</Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </td>
  );
}

type UploadPreview = { file: string; rows: UpGroup["rows"]; notes: string[]; asOf: string | null; mismatch: string[] };

/** 仓库小卡片：库存状态 + API 同步 / 上传覆盖 / 查看；状态与仓库系统设置收在「⋯」里 */
function StockTile({ w, maxAge, reload }: { w: SeaWarehouse; maxAge: number; reload: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<UploadPreview | null>(null);
  const [stock, setStock] = React.useState<StockRow[] | null>(null);
  const [provWhs, setProvWhs] = React.useState<Array<{ ref: string; name: string; code: string | null; country: string | null }> | null>(null);
  const hasApi = ["qianyi", "dingmiao"].includes(w.provider);
  const st = stockState(w, maxAge);

  const save = async (p: Partial<SeaWarehouse>) => {
    setBusy(true);
    try { await seaApi.saveWarehouse({ code: w.code, ...p }); await reload(); toast.success("已保存"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  /** 上传导出表：只取文件里属于本仓的行（按「仓库」列匹配；文件没有仓库列则整份），多个 sheet 合并 */
  const onFile = async (f: File) => {
    setBusy(true);
    try {
      const groups = await parseUploadFile(f, false);
      const withWh = groups.filter((g) => g.whValue !== null);
      const mine = withWh.length ? groups.filter((g) => g.whValue !== null && matchWarehouse(g.whValue, [w]) === w) : groups;
      const rows = new Map<string, UpGroup["rows"][number]>();
      for (const g of mine) for (const r of g.rows) {
        const prev = rows.get(r.wh_sku);
        rows.set(r.wh_sku, prev ? { ...prev, available: prev.available + r.available } : { ...r });
      }
      const mismatch = withWh.length && !mine.length ? [...new Set(withWh.map((g) => g.whValue!))] : [];
      setPreview({ file: f.name, rows: [...rows.values()], notes: [...new Set(mine.flatMap((g) => g.notes))], asOf: mine.find((g) => g.exportTime)?.exportTime ?? null, mismatch });
    } catch (e) { toast.error(`解析失败：${(e as Error).message}`); } finally { setBusy(false); }
  };
  const doImport = async () => {
    if (!preview?.rows.length) return;
    setBusy(true);
    try {
      const r = await seaApi.importStock(w.code, preview.rows, { as_of: preview.asOf, file_name: preview.file });
      toast.success(`${w.name}：已覆盖 ${r.rows} 个 SKU，可用合计 ${r.total_available}`);
      r.errors.forEach((e) => toast.warning(e));
      setPreview(null); await reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true);
    try {
      const r = await seaApi.syncWarehouse(w.code);
      if (!r.ok) toast.error(r.error ?? "失败");
      else toast.success(r.message ?? `${w.name}：已同步 ${r.rows ?? 0} 个 SKU，可用合计 ${r.total_available ?? 0}`);
      [...(r.notes ?? []), ...(r.errors ?? [])].forEach((n) => toast.warning(n));
      await reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className={`rounded-lg border bg-card overflow-hidden ${w.status === "disabled" ? "opacity-60" : ""}`}>
      <div className={`h-1 ${regionStyle(w.region).bar}`} />
      <div className="p-3 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${regionStyle(w.region).chip}`}>{w.region ?? "—"}</span>
          <span className="font-medium truncate" title={w.note ?? ""}>{w.name}</span>
          <Popover>
            <PopoverTrigger asChild><button className="ml-auto px-1.5 rounded hover:bg-muted text-muted-foreground" title="更多设置">⋯</button></PopoverTrigger>
            <PopoverContent className="w-80 text-sm space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-20 text-muted-foreground">状态</span>
                <select className="h-8 flex-1 rounded-md border px-2" value={w.status} disabled={busy} onChange={(e) => save({ status: e.target.value as SeaWarehouse["status"] })}>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              {hasApi && (
                <div className="flex items-center gap-2">
                  <span className="w-20 text-muted-foreground">系统仓库</span>
                  {provWhs ? (
                    <select className="h-8 flex-1 min-w-0 rounded-md border px-2 text-xs" value={w.provider_ref ?? ""} disabled={busy} onChange={(e) => save({ provider_ref: e.target.value })}>
                      <option value="">选择…</option>
                      {provWhs.map((x) => <option key={x.ref} value={x.ref}>{x.name}{x.code ? `（${x.code}）` : ""}</option>)}
                    </select>
                  ) : (
                    <>
                      <span className="font-mono text-xs flex-1">{w.provider_ref ?? "未选择"}</span>
                      <Button size="sm" variant="ghost" onClick={async () => { try { setProvWhs((await seaApi.providerWarehouses(w.code)).warehouses); } catch (e) { toast.error((e as Error).message); } }}>修改</Button>
                    </>
                  )}
                </div>
              )}
              {w.note && <div className="text-xs text-muted-foreground">{w.note}</div>}
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 shrink-0 rounded-full ${TONE_DOT[st.tone]}`} />
          <span className={`whitespace-nowrap ${st.tone === "ok" ? "" : st.tone === "off" ? "text-muted-foreground" : "text-red-600 font-medium"}`}
            title={`库存时间超过 ${maxAge} 小时算过期（参数页可改），过期的仓本次计划跳过`}>{st.label}</span>
          <span className="text-xs text-muted-foreground ml-auto truncate min-w-0" title={`库存时间 ${bj(w.stock_synced_at)}`}>
            {shortTime(w.stock_synced_at)} · {w.stock_source === "api" ? "API" : w.stock_source === "manual" ? "上传" : "—"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 whitespace-nowrap" title="SKU 数（其中可用 > 0 的个数）· 可用件数合计">
          <span><b className="text-lg tabular-nums">{(w.stock_totals?.skus ?? 0).toLocaleString()}</b> <span className="text-xs">SKU</span> <span className="text-xs text-muted-foreground">· 有货 {(w.stock_totals?.in_stock ?? 0).toLocaleString()}</span></span>
          <span><b className="text-lg tabular-nums">{(w.stock_totals?.units ?? 0).toLocaleString()}</b> <span className="text-xs">件</span></span>
        </div>
        {!w.links.length && w.status !== "disabled" && <div className="text-xs text-red-600">未配对店铺，计划不含此仓</div>}
        {w.stock_error && <div className="text-xs text-red-600 line-clamp-2" title={w.stock_error}>⚠ {w.stock_error}</div>}
        <div className="flex items-center gap-1">
          {hasApi && <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={sync}><RefreshCw className="h-3.5 w-3.5 mr-1" />同步</Button>}
          <label className="inline-flex">
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={busy} onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (f) void onFile(f);
            }} />
            <span className="inline-flex items-center h-7 px-2 rounded-md border text-xs cursor-pointer hover:bg-muted"><Upload className="h-3.5 w-3.5 mr-1" />上传覆盖</span>
          </label>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={async () => {
            if (stock) { setStock(null); return; }
            try { setStock((await seaApi.stockList(w.code)).rows); } catch (e) { toast.error((e as Error).message); }
          }}>{stock ? "收起" : "查看"}</Button>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        {preview && (
          <div className="rounded border p-2 space-y-1 text-xs">
            <div className="text-muted-foreground break-all">{preview.file}{preview.asOf && `，导出 ${shortTime(preview.asOf)}`}</div>
            {preview.mismatch.length ? (
              <div className="text-red-600">文件里的仓库是「{preview.mismatch.join("、")}」，不是本仓，未导入</div>
            ) : (
              <>
                <div>{preview.rows.length} 个 SKU（有货 {preview.rows.filter((r) => r.available > 0).length}），可用合计 {preview.rows.reduce((t, r) => t + r.available, 0)}，<b>整仓覆盖</b></div>
                {preview.notes.map((n, i) => <div key={i} className="text-amber-700">⚠ {n}</div>)}
                {hasApi && <div className="text-amber-700">该仓有 API，下次同步会被 API 数据替换</div>}
              </>
            )}
            <div className="flex gap-1">
              <Button size="sm" className="h-7" disabled={busy || !preview.rows.length || preview.mismatch.length > 0} onClick={doImport}>确认覆盖</Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setPreview(null)}>取消</Button>
            </div>
          </div>
        )}
        {stock && (
          <div className="max-h-40 overflow-auto font-mono text-[11px] border rounded p-1.5">
            {stock.filter((r) => r.available > 0).map((r) => <div key={r.wh_sku}>{r.wh_sku}  {r.available}</div>)}
            {!stock.some((r) => r.available > 0) && "无可用库存"}
            {stock.some((r) => r.available <= 0) && <div className="text-muted-foreground">另有 {stock.filter((r) => r.available <= 0).length} 个 SKU 为 0</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ SKU 映射表 ═════════════════════════════════════════════════════════════
function MapPanel({ ov }: { ov: Overview }) {
  const [rows, setRows] = React.useState<MapRow[] | null>(null);
  const [q, setQ] = React.useState("");
  const [onlyMulti, setOnlyMulti] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const load = async () => { try { setRows((await seaApi.mapList()).rows); } catch (e) { toast.error((e as Error).message); } };
  React.useEffect(() => { void load(); }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await seaApi.refreshMap();
      toast.success(`映射表 ${r.total} 行；同 SKU 多 listing ${r.multi_listing_skus} 个；新增 ${r.counts.added}、下架 ${r.counts.removed}、SKU 变更 ${r.counts.changed}`);
      await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const shopLabel = (id: string) => { const s = ov.shops.find((x) => x.shop_id === id); return s ? `${s.region ?? ""} ${s.shop_name ?? id}` : id; };
  const groups = React.useMemo(() => {
    const m = new Map<string, MapRow[]>();
    for (const r of rows ?? []) m.set(r.wh_sku, [...(m.get(r.wh_sku) ?? []), r]);
    return [...m.entries()]
      .filter(([k, g]) => (!onlyMulti || g.length > 1) && (!q || k.toLowerCase().includes(q.toLowerCase()) || g.some((r) => r.slots.some((x) => x.title?.toLowerCase().includes(q.toLowerCase())))))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [rows, q, onlyMulti]);
  return (
    <div className="space-y-3 mt-3">
      <div className="text-sm text-muted-foreground">
        listing 的商家 SKU 与仓库 SKU <b>完全一致</b>（区分大小写，只去首尾空格）才视为同一实物，包装不同的编码不会合并。编码对不上时可在下面填「人工指定仓库 SKU」。
        每晚 21:10 自动刷新并比对变化（上次 {bj(ov.settings.map_refreshed_at)}）。
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={refresh} disabled={busy}><RefreshCw className="h-4 w-4 mr-1" />立即刷新映射表</Button>
        <Input className="h-8 w-56" placeholder="搜 SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1 text-sm"><Checkbox checked={onlyMulti} onCheckedChange={(v) => setOnlyMulti(v === true)} />只看多 listing 的 SKU</label>
        <span className="text-sm text-muted-foreground">{groups.length} 个仓库 SKU</span>
      </div>
      {!rows ? <Loading /> : (
        <div className="space-y-2">
          {groups.slice(0, 300).map(([sku, g]) => (
            <Card key={sku}><CardContent className="p-2 text-sm">
              <div className="font-mono font-medium">{sku} <span className="text-muted-foreground font-normal">· {g.length} 个 listing</span></div>
              {g.map((r) => (
                <div key={`${r.shop_id}|${r.sku_id}`} className="flex flex-wrap items-center gap-2 pl-3 text-xs">
                  <span>{shopLabel(r.shop_id)}</span>
                  <span className="font-mono">{r.seller_sku}</span>
                  {r.prev_seller_sku && <Badge variant="outline" className="text-amber-700">原 {r.prev_seller_sku}，{bj(r.changed_at)} 变更</Badge>}
                  <span className="text-muted-foreground">{r.slots.map((s) => `仓 ${s.tts_warehouse_id.slice(-6)}: ${s.qty} 件 / 卖 ${s.sold}`).join("；")}</span>
                  <Input className="h-6 w-40 text-xs" placeholder="人工指定仓库 SKU" defaultValue={r.wh_sku_override ?? ""}
                    onBlur={async (e) => {
                      const v = e.target.value.trim();
                      if (v === (r.wh_sku_override ?? "")) return;
                      try { await seaApi.setOverride(r.shop_id, r.sku_id, v); toast.success("已保存，下次生成计划生效"); } catch (err) { toast.error((err as Error).message); }
                    }} />
                </div>
              ))}
            </CardContent></Card>
          ))}
          {groups.length > 300 && <div className="text-sm text-muted-foreground">只显示前 300 个，请搜索</div>}
        </div>
      )}
    </div>
  );
}

// ═══ 参数 ═══════════════════════════════════════════════════════════════════
const FIELDS: Array<[keyof Overview["settings"], string, string]> = [
  ["window_days", "销量统计窗口（天）", "近 N 天订单算日均销量（待确认：默认 14）"],
  ["min_days", "预警天数（海外仓）", "listing 可售天数全部 ≥ 此值就不调整；低于才调"],
  ["target_days", "补到目标天数（海外仓）", "低于预警的补到这么多天销量；先用仓库未分配，再从可售最多的调（待确认：默认 30）"],
  ["min_qty", "listing 数量低于（件）", "少于此件数也算预警（含无销量的），负责人口径 5"],
  ["reserve_per_sku", "每 SKU 海外仓预留", "负责人口径 5，不分配给 listing"],
  ["zero_sale_qty", "无销量 listing 补到（件）", "近 N 天没卖出的 listing，少于 5 件时补到这个数（待确认：默认 5）"],
  ["cn_min_days", "国内仓触发：可售天数 <", "负责人口径 10"],
  ["cn_target_days", "国内仓补到（天销量）", "待确认：默认 20"],
  ["stock_max_age_hours", "海外仓库存最长有效（小时）", "超过则该仓本次不调整"],
];
function SettingsPanel({ ov, reload }: { ov: Overview; reload: () => Promise<void> }) {
  const [v, setV] = React.useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, String(ov.settings[k] ?? "")])));
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true);
    try { await seaApi.saveSettings(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)]))); toast.success("已保存，下次生成计划生效"); await reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="mt-3"><CardContent className="p-4 space-y-2 text-sm">
      {FIELDS.map(([k, label, hint]) => (
        <div key={k} className="flex items-center gap-3">
          <span className="w-56">{label}</span>
          <Input type="number" className="h-8 w-24" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          <span className="text-muted-foreground text-xs">{hint}</span>
        </div>
      ))}
      <Button onClick={save} disabled={busy}>保存</Button>
    </CardContent></Card>
  );
}
