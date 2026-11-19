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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getAdminName, getPasscode } from "@/lib/api";
import { matchWarehouse, parseUploadFile, type UpGroup } from "@/lib/stockUpload";
import {
  type MapRow, type Overview, type PlanItem, type PlanRow,
  type SeaShop, type SeaWarehouse, seaApi, sendPlanToFeishu, type StockRow,
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
// 国内仓不在这里：不绑定、不设库存，只在调整计划里做预警（未绑定到任何海外仓的 TikTok 仓库都算国内仓）
function WarehousePanel({ ov, reload }: { ov: Overview; reload: () => Promise<void> }) {
  return (
    <div className="space-y-3 mt-3">
      <div className="text-sm text-muted-foreground">
        每个海外仓绑定各店铺在 TikTok 里对应的仓库（一个店铺一个 warehouse_id）。库存来源：千易 / 顶妙点「API 同步」，其他仓点「上传覆盖库存」上传导出表。
        库存超过 {ov.settings.stock_max_age_hours} 小时未更新的仓本次不参与调整。国内仓不用绑定，没绑定到海外仓的 TikTok 仓库自动按国内仓预警。
      </div>
      <ShopSyncCard ov={ov} />
      {ov.warehouses.filter((w) => w.kind === "overseas").map((w) => <WarehouseCard key={w.code} w={w} shops={ov.shops} reload={reload} />)}
    </div>
  );
}

function ShopSyncCard({ ov }: { ov: Overview }) {
  if (!ov.shop_sync.length) return null;
  const name = (id: string) => { const s = ov.shops.find((x) => x.shop_id === id); return s ? `${s.region ?? ""} ${s.shop_name ?? id}` : id; };
  return (
    <Card><CardContent className="p-3 text-sm space-y-1">
      <div className="font-medium">店铺同步状态</div>
      {ov.shop_sync.map((s) => (
        <div key={s.shop_id} className={s.error ? "text-red-600" : ""}>
          {name(s.shop_id)}：listing {bj(s.listings_at)}（{s.slots_count ?? 0} 个槽位），订单 {bj(s.orders_at)}（本次拉 {s.orders_count ?? 0} 单，日销量已存到 {s.sales_synced_day ?? "—"}）{s.error && ` ⚠ ${s.error}`}
        </div>
      ))}
    </CardContent></Card>
  );
}

type UploadPreview = { file: string; rows: UpGroup["rows"]; notes: string[]; asOf: string | null; mismatch: string[] };

function WarehouseCard({ w, shops, reload }: { w: SeaWarehouse; shops: SeaShop[]; reload: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [shopId, setShopId] = React.useState("");
  const [ttsWhs, setTtsWhs] = React.useState<Array<{ id: string; name?: string; type?: string }>>([]);
  const [ttsWh, setTtsWh] = React.useState("");
  const [preview, setPreview] = React.useState<UploadPreview | null>(null);
  const [stock, setStock] = React.useState<StockRow[] | null>(null);
  const [provWhs, setProvWhs] = React.useState<Array<{ ref: string; name: string; code: string | null; country: string | null }> | null>(null);
  const hasApi = ["qianyi", "dingmiao"].includes(w.provider);
  const shopLabel = (id: string) => { const s = shops.find((x) => x.shop_id === id); return s ? `${s.region ?? ""} ${s.shop_name ?? id}` : id; };

  const save = async (p: Partial<SeaWarehouse>) => {
    setBusy(true);
    try { await seaApi.saveWarehouse({ code: w.code, ...p }); await reload(); toast.success("已保存"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const loadTts = async (sid: string) => {
    setShopId(sid); setTtsWhs([]); setTtsWh("");
    if (!sid) return;
    try {
      const r = await seaApi.shopWarehouses(sid);
      setTtsWhs(r.warehouses);
      if (r.fallback) toast.warning(r.error ?? "读不到仓库名称，已改为从在售商品汇总仓库 ID", { duration: 10000 });
    } catch (e) { toast.error((e as Error).message); }
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
      toast.success(`已覆盖：${r.rows} 个 SKU，可用合计 ${r.total_available}`);
      r.errors.forEach((e) => toast.warning(e));
      setPreview(null); await reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true);
    try {
      const r = await seaApi.syncWarehouse(w.code);
      if (!r.ok) toast.error(r.error ?? "失败");
      else toast.success(r.message ?? `已同步 ${r.rows ?? 0} 个 SKU，可用合计 ${r.total_available ?? 0}`);
      [...(r.notes ?? []), ...(r.errors ?? [])].forEach((n) => toast.warning(n));
      await reload();
    }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const stale = ageH(w.stock_synced_at) > 26;

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          {w.name}
          <Badge variant="outline">海外仓 {w.region ?? ""}</Badge>
          <Badge variant="secondary">{PROVIDER_LABEL[w.provider] ?? w.provider}</Badge>
          <select className="ml-auto h-8 rounded-md border px-2 text-sm font-normal" value={w.status} disabled={busy} onChange={(e) => save({ status: e.target.value as SeaWarehouse["status"] })}>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {w.note && <div className="text-muted-foreground">{w.note}</div>}
        <div>
          <div className="font-medium mb-1">绑定的 TikTok 仓库</div>
          {!w.links.length && <div className="text-amber-700">未绑定，计划不会包含这个仓</div>}
          {w.links.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <span>{shopLabel(l.shop_id)}</span><span className="font-mono text-xs">{l.tts_warehouse_id}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => save({ links: w.links.filter((_, k) => k !== i) })}>移除</Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <select className="h-8 rounded-md border px-2" value={shopId} onChange={(e) => loadTts(e.target.value)}>
              <option value="">选择店铺…</option>
              {shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.region} {s.shop_name}</option>)}
            </select>
            <select className="h-8 rounded-md border px-2" value={ttsWh} onChange={(e) => setTtsWh(e.target.value)} disabled={!ttsWhs.length}>
              <option value="">选择 TikTok 仓库…</option>
              {ttsWhs.map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}{x.type ? `（${x.type}）` : ""}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={busy || !shopId || !ttsWh}
              onClick={() => save({ links: [...w.links.filter((l) => l.shop_id !== shopId || l.tts_warehouse_id !== ttsWh), { shop_id: shopId, tts_warehouse_id: ttsWh }] })}>添加绑定</Button>
          </div>
        </div>
        {hasApi && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">仓库系统里的仓库：</span>
            <span className="font-mono text-xs">{w.provider_ref ?? <span className="text-amber-700">未选择，API 同步会失败</span>}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
              try { setProvWhs((await seaApi.providerWarehouses(w.code)).warehouses); } catch (e) { toast.error((e as Error).message); }
            }}>读取仓库列表</Button>
            {provWhs && (
              <select className="h-8 rounded-md border px-2" value={w.provider_ref ?? ""} disabled={busy} onChange={(e) => save({ provider_ref: e.target.value })}>
                <option value="">选择…</option>
                {provWhs.map((x) => <option key={x.ref} value={x.ref}>{x.name}{x.code ? `（${x.code}）` : ""}{x.country ? ` ${x.country}` : ""}</option>)}
              </select>
            )}
          </div>
        )}
        <div className="space-y-2">
          <div className={stale ? "text-red-600" : ""}>
            库存：{w.stock_rows ?? 0} 个 SKU，更新于 {bj(w.stock_synced_at)}（{w.stock_source === "api" ? "API" : w.stock_source === "manual" ? `上传${w.stock_file_name ? `「${w.stock_file_name}」` : ""}` : "—"}）
            {stale && "，已过期，计划会跳过这个仓"}
            {w.stock_error && <div className="text-red-600">⚠ {w.stock_error}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasApi && <Button size="sm" variant="outline" disabled={busy} onClick={sync}><RefreshCw className="h-4 w-4 mr-1" />API 同步</Button>}
            <label className="inline-flex">
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={busy} onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = "";
                if (f) void onFile(f);
              }} />
              <span className="inline-flex items-center h-8 px-3 rounded-md border cursor-pointer hover:bg-muted"><Upload className="h-4 w-4 mr-1" />上传覆盖库存</span>
            </label>
            <Button size="sm" variant="ghost" onClick={async () => { try { setStock((await seaApi.stockList(w.code)).rows); } catch (e) { toast.error((e as Error).message); } }}>查看当前库存</Button>
            {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {preview && (
            <div className="rounded border p-2 space-y-1">
              <div className="text-xs text-muted-foreground break-all">{preview.file}{preview.asOf && `，导出时间 ${bj(preview.asOf)}`}</div>
              {preview.mismatch.length ? (
                <div className="text-red-600">文件里的仓库是「{preview.mismatch.join("、")}」，不是本仓（{w.file_config?.warehouse_value ?? w.provider_ref ?? w.name}），未导入。请确认选对了文件。</div>
              ) : (
                <>
                  <div>识别 {preview.rows.length} 个 SKU（有货 {preview.rows.filter((r) => r.available > 0).length}），可用合计 {preview.rows.reduce((t, r) => t + r.available, 0)}。<b>会整仓覆盖</b>：表里没有的 SKU 视为无货。</div>
                  {preview.notes.map((n, i) => <div key={i} className="text-amber-700">⚠ {n}</div>)}
                  {hasApi && <div className="text-amber-700">该仓有 API，上传会覆盖 API 数据，下次 API 同步后又会被替换。</div>}
                </>
              )}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || !preview.rows.length || preview.mismatch.length > 0} onClick={doImport}>确认覆盖</Button>
                <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>取消</Button>
              </div>
            </div>
          )}
          {stock && (
            <div className="max-h-60 overflow-auto font-mono text-xs border rounded p-2">
              {stock.map((r) => <div key={r.wh_sku}>{r.wh_sku}  可用 {r.available}{r.product_name ? `  ${r.product_name}` : ""}</div>)}
              {!stock.length && "无"}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
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
