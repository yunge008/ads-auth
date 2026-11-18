import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2, Play, RefreshCw, Send, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getAdminName, getPasscode } from "@/lib/api";
import { matchWarehouse, parseUploadFile, type UpGroup } from "@/lib/stockUpload";
import {
  type MapRow, type Overview, parseStockPaste, type ParsedStock, type PlanItem, type PlanRow,
  type SeaShop, type SeaWarehouse, seaApi, type DrivePreview, type FileConfig, sendPlanToFeishu, type StockRow,
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
          海外仓库存按销量分配到各 listing，国内仓按可售天数补货。每天北京 09:10 / 21:10 自动生成计划并推送飞书，<b>只有在本页确认执行后才会改 TikTok 库存</b>。
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

  async function generate() {
    try {
      for (const sid of ov.linked_shops) {
        let cursor: unknown = null, n = 0;
        do {
          setBusy(`同步店铺 ${shopName(sid)}（第 ${++n} 段）…`);
          const r = await seaApi.syncShop(sid, cursor);
          cursor = r.done ? null : r.cursor;
        } while (cursor);
      }
      setBusy("生成计划…");
      const r = await seaApi.buildPlan();
      toast.success(`已生成：海外仓 ${r.summary.overseas} 条、国内仓 ${r.summary.cn} 条${r.warnings.length ? `，${r.warnings.length} 条数据提示` : ""}`);
      await reload();
      setPlanId(r.plan_id);
      await loadPlan(r.plan_id);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

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
        <Button onClick={generate} disabled={!!busy || notConfigured}><RefreshCw className="h-4 w-4 mr-1" />同步并生成计划</Button>
        <select className="h-9 rounded-md border px-2 text-sm" value={planId ?? ""} onChange={(e) => setPlanId(e.target.value || undefined)}>
          {ov.plans.map((p) => <option key={p.id} value={p.id}>{bj(p.created_at)} · {p.source === "CRON" ? "定时" : "手动"} · {PLAN_STATUS[p.status] ?? p.status}</option>)}
          {!ov.plans.length && <option value="">暂无计划</option>}
        </select>
        <Button variant="outline" onClick={feishu} disabled={!!busy || !plan}><Send className="h-4 w-4 mr-1" />发送到飞书</Button>
        <Button onClick={() => setConfirmOpen(true)} disabled={!!busy || !editable || !toRun.length} className="bg-red-600 hover:bg-red-700">
          <Play className="h-4 w-4 mr-1" />确认执行所选（{toRun.length}）
        </Button>
        {busy && <span className="flex items-center gap-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{busy}</span>}
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
      <ItemTable title="国内仓" hint="国内仓实物库存未接入，勾选前请确认仓库确有货" items={cnItems} editable={!!editable} shopName={shopName} whName={whName} onPatch={patch} onAll={(v) => setAll("cn", v)} />

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
function WarehousePanel({ ov, reload }: { ov: Overview; reload: () => Promise<void> }) {
  return (
    <div className="space-y-3 mt-3">
      <div className="text-sm text-muted-foreground">
        每个实体仓绑定各店铺在 TikTok 里对应的仓库（一个店铺一个 warehouse_id）。海外仓库存超过 {ov.settings.stock_max_age_hours} 小时未更新的仓本次不参与调整。
        泰国新仓启用时把状态改为「新仓接入中」：listing 还没挂新仓的会生成「新仓首次」设置项；顶妙 TH1 设为「逐步退出」。
      </div>
      <BatchUploadCard ov={ov} reload={reload} />
      <ShopSyncCard ov={ov} />
      {ov.warehouses.map((w) => <WarehouseCard key={w.code} w={w} shops={ov.shops} reload={reload} />)}
    </div>
  );
}

type Pick = { include: boolean; target: string };
/** 批量上传：一次选多个导出文件（BigSeller / 顶妙 / 千易），按文件里的「仓库」列自动分到对应仓，预览后导入（整仓覆盖） */
function BatchUploadCard({ ov, reload }: { ov: Overview; reload: () => Promise<void> }) {
  const [groups, setGroups] = React.useState<UpGroup[]>([]);
  const [picks, setPicks] = React.useState<Record<string, Pick>>({});
  const [includeCombo, setIncludeCombo] = React.useState(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const overseas = ov.warehouses.filter((w) => w.kind === "overseas");
  const isApi = (code: string) => ["qianyi", "dingmiao"].includes(ov.warehouses.find((w) => w.code === code)?.provider ?? "");

  const parse = async (fs: File[], combo: boolean) => {
    setBusy(true);
    try {
      const all: UpGroup[] = [];
      for (const f of fs) all.push(...(await parseUploadFile(f, combo)));
      const p: Record<string, Pick> = {};
      for (const g of all) {
        const w = matchWarehouse(g.whValue, overseas);
        // 能走 API 的仓默认不导入（以 API 为准），只做核对
        p[g.key] = { target: w?.code ?? "", include: !!w && g.rows.length > 0 && !isApi(w.code) };
      }
      setGroups(all); setPicks(p);
    } catch (e) { toast.error(`解析失败：${(e as Error).message}`); } finally { setBusy(false); }
  };

  const doImport = async () => {
    // 同一目标仓的多个分组合并（如含组合 SKU 时单品表 + 组合表）
    const byWh = new Map<string, { rows: Map<string, UpGroup["rows"][number]>; asOf: string | null; files: Set<string> }>();
    for (const g of groups) {
      const pk = picks[g.key];
      if (!pk?.include || !pk.target) continue;
      const cur = byWh.get(pk.target) ?? { rows: new Map(), asOf: null, files: new Set<string>() };
      for (const r of g.rows) {
        const prev = cur.rows.get(r.wh_sku);
        cur.rows.set(r.wh_sku, prev ? { ...prev, available: prev.available + r.available } : { ...r });
      }
      // 库存时间取各文件里最早的导出时间（保守）
      if (g.exportTime && (!cur.asOf || g.exportTime < cur.asOf)) cur.asOf = g.exportTime;
      cur.files.add(g.file);
      byWh.set(pk.target, cur);
    }
    if (!byWh.size) { toast.error("没有勾选要导入的仓"); return; }
    setBusy(true);
    try {
      for (const [code, x] of byWh) {
        const r = await seaApi.importStock(code, [...x.rows.values()], { as_of: x.asOf, file_name: [...x.files].join("、") });
        toast.success(`${ov.warehouses.find((w) => w.code === code)?.name ?? code}：导入 ${r.rows} 个 SKU，可用合计 ${r.total_available}`);
        r.errors.forEach((e) => toast.warning(e));
      }
      setGroups([]); setPicks({}); setFiles([]);
      await reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Card><CardContent className="p-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">上传库存表</span>
        <label className="inline-flex">
          <input type="file" multiple accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => {
            const fs = [...(e.target.files ?? [])]; e.target.value = "";
            if (fs.length) { setFiles(fs); void parse(fs, includeCombo); }
          }} />
          <span className="inline-flex items-center h-8 px-3 rounded-md border cursor-pointer hover:bg-muted"><Upload className="h-4 w-4 mr-1" />选择文件（可多选）</span>
        </label>
        <label className="flex items-center gap-1"><Checkbox checked={includeCombo} onCheckedChange={(v) => { setIncludeCombo(v === true); if (files.length) void parse(files, v === true); }} />含组合 SKU</label>
        <span className="text-xs text-muted-foreground">支持 BigSeller、顶妙 TOPWMS、千易导出；按文件里的「仓库」列自动分仓，<b>导入会整仓覆盖</b>。千易 / 顶妙有 API 的仓默认不勾选，只用来核对。</span>
      </div>
      {busy && <div className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />处理中…</div>}
      {!!groups.length && (
        <>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground"><tr className="[&>th]:text-left [&>th]:px-1">
              <th>导入</th><th>文件 / sheet</th><th>文件里的仓库</th><th>导入到</th><th className="text-right">SKU</th><th className="text-right">有货</th><th className="text-right">可用合计</th><th>导出时间</th><th>说明</th>
            </tr></thead>
            <tbody>
              {groups.map((g) => {
                const pk = picks[g.key] ?? { include: false, target: "" };
                return (
                  <tr key={g.key} className="border-t align-top [&>td]:px-1 [&>td]:py-1">
                    <td><Checkbox checked={pk.include} disabled={!pk.target || !g.rows.length} onCheckedChange={(v) => setPicks({ ...picks, [g.key]: { ...pk, include: v === true } })} /></td>
                    <td className="max-w-[220px] break-all">{g.file}<div className="text-muted-foreground">{g.sheet}</div></td>
                    <td>{g.whValue ?? "（无仓库列）"}</td>
                    <td>
                      <select className="h-7 rounded border px-1" value={pk.target} onChange={(e) => setPicks({ ...picks, [g.key]: { target: e.target.value, include: !!e.target.value && g.rows.length > 0 } })}>
                        <option value="">选择仓库…</option>
                        {overseas.map((w) => <option key={w.code} value={w.code}>{w.name}</option>)}
                      </select>
                      {pk.target && isApi(pk.target) && <div className="text-amber-700">该仓有 API，导入会覆盖 API 数据</div>}
                    </td>
                    <td className="text-right">{g.rows.length}</td>
                    <td className="text-right">{g.rows.filter((r) => r.available > 0).length}</td>
                    <td className="text-right">{g.rows.reduce((t, r) => t + r.available, 0)}</td>
                    <td>{g.exportTime ? bj(g.exportTime) : "—"}</td>
                    <td className="max-w-[260px]">{g.notes.join("；")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Button size="sm" disabled={busy || !Object.values(picks).some((p) => p.include)} onClick={doImport}>导入勾选的仓</Button>
        </>
      )}
    </CardContent></Card>
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
          {name(s.shop_id)}：listing {bj(s.listings_at)}（{s.slots_count ?? 0} 个槽位），订单 {bj(s.orders_at)}（{s.orders_count ?? 0} 单）{s.error && ` ⚠ ${s.error}`}
        </div>
      ))}
    </CardContent></Card>
  );
}

function WarehouseCard({ w, shops, reload }: { w: SeaWarehouse; shops: SeaShop[]; reload: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [shopId, setShopId] = React.useState("");
  const [ttsWhs, setTtsWhs] = React.useState<Array<{ id: string; name?: string; type?: string }>>([]);
  const [ttsWh, setTtsWh] = React.useState("");
  const [parsed, setParsed] = React.useState<ParsedStock | null>(null);
  const [paste, setPaste] = React.useState("");
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
    try { setTtsWhs((await seaApi.shopWarehouses(sid)).warehouses); } catch (e) { toast.error((e as Error).message); }
  };
  const doImport = async () => {
    if (!parsed?.rows.length) return;
    setBusy(true);
    try {
      const r = await seaApi.importStock(w.code, parsed.rows);
      toast.success(`已导入 ${r.rows} 个 SKU，可用合计 ${r.total_available}`);
      r.errors.forEach((e) => toast.warning(e));
      setParsed(null); setPaste(""); await reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const sync = async (force = false) => {
    setBusy(true);
    try {
      const r = await seaApi.syncWarehouse(w.code, force);
      if (!r.ok) toast.error(r.error ?? "失败");
      else toast.success(r.message ?? `已同步 ${r.rows ?? 0} 个 SKU，可用合计 ${r.total_available ?? 0}${r.file ? `（文件「${r.file}」）` : ""}`);
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
          <Badge variant="outline">{w.kind === "cn" ? "国内仓" : `海外仓 ${w.region ?? ""}`}</Badge>
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
              {ttsWhs.map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}（{x.type ?? ""}）</option>)}
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
        {w.kind === "overseas" && <DriveConfig w={w} reload={reload} />}
        {w.kind === "overseas" && (
          <div className="space-y-2">
            <div className={stale ? "text-red-600" : ""}>
              库存：{w.stock_rows ?? 0} 个 SKU，更新于 {bj(w.stock_synced_at)}（{w.stock_source === "api" ? "API" : w.stock_source === "drive" ? `云盘「${w.stock_file_name ?? ""}」，按文件修改时间计` : w.stock_source === "manual" ? "手动导入" : "—"}）
              {stale && "，已过期，计划会跳过这个仓"}
              {w.stock_error && <div className="text-red-600">⚠ {w.stock_error}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(hasApi || w.drive_folder) && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => sync(!!w.drive_folder)}>
                  <RefreshCw className="h-4 w-4 mr-1" />{w.drive_folder ? "从云盘同步" : "API 同步"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={async () => { try { setStock((await seaApi.stockList(w.code)).rows); } catch (e) { toast.error((e as Error).message); } }}>查看当前库存</Button>
            </div>
            <Textarea rows={2} placeholder="粘贴两列：SKU ⇥ 可用库存（可带表头，Excel 直接复制）；整份文件请用上方「上传库存表」" value={paste}
              onChange={(e) => { setPaste(e.target.value); setParsed(e.target.value.trim() ? parseStockPaste(e.target.value) : null); }} />
            {parsed && (
              <div className="rounded border p-2 space-y-1">
                <div>识别 {parsed.rows.length} 个 SKU，可用合计 {parsed.rows.reduce((s, r) => s + r.available, 0)}。<b>导入会整仓覆盖</b>（表里没有的 SKU 视为 0 / 无货）。</div>
                {parsed.notes.map((n, i) => <div key={i} className="text-amber-700">⚠ {n}</div>)}
                <div className="font-mono text-xs max-h-32 overflow-auto whitespace-pre">{parsed.rows.slice(0, 20).map((r) => `${r.wh_sku}  ${r.available}`).join("\n")}{parsed.rows.length > 20 && "\n…"}</div>
                <Button size="sm" disabled={busy || !parsed.rows.length} onClick={doImport}>确认导入</Button>
              </div>
            )}
            {stock && (
              <div className="max-h-60 overflow-auto font-mono text-xs border rounded p-2">
                {stock.map((r) => <div key={r.wh_sku}>{r.wh_sku}  可用 {r.available}{r.product_name ? `  ${r.product_name}` : ""}</div>)}
                {!stock.length && "无"}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const FC_FIELDS: Array<[keyof FileConfig, string]> = [
  ["sku_col", "SKU 列表头"], ["avail_col", "可用数量列表头"], ["sheet", "sheet 名"],
  ["warehouse_col", "仓库列表头"], ["warehouse_value", "只取该仓库"], ["onhand_col", "在库列表头"],
];
/** 云盘（RPA 导出）配置：填了文件夹就优先从云盘取，不再走 API */
function DriveConfig({ w, reload }: { w: SeaWarehouse; reload: () => Promise<void> }) {
  const [open, setOpen] = React.useState(!!w.drive_folder);
  const [folder, setFolder] = React.useState(w.drive_folder ?? "");
  const [pattern, setPattern] = React.useState(w.drive_name_pattern ?? "");
  const [fc, setFc] = React.useState<FileConfig>(w.file_config ?? {});
  const [pv, setPv] = React.useState<DrivePreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  if (!open) return <Button size="sm" variant="ghost" className="px-0" onClick={() => setOpen(true)}>＋ 配置云盘自动导入（RPA 导出 Excel）</Button>;
  const preview = async () => {
    setBusy(true);
    try { setPv(await seaApi.drivePreview(w.code, { drive_folder: folder, drive_name_pattern: pattern, file_config: fc })); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await seaApi.saveWarehouse({ code: w.code, drive_folder: folder.trim(), drive_name_pattern: pattern.trim(), file_config: fc }); toast.success(folder.trim() ? "已保存：之后该仓库存从云盘取" : "已清空云盘配置"); await reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="rounded border p-2 space-y-2">
      <div className="font-medium">云盘自动导入 <span className="text-xs font-normal text-muted-foreground">填了文件夹后，定时任务取文件夹里最新一份表格（xlsx/xls/csv/Google 表格），库存时间按文件修改时间算，超过有效期的不参与调整</span></div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-96" placeholder="Google 云盘文件夹链接（需共享给服务账号邮箱）" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <Input className="h-8 w-40" placeholder="文件名包含（可空）" value={pattern} onChange={(e) => setPattern(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {FC_FIELDS.map(([k, label]) => (
          <Input key={k} className="h-7 w-32 text-xs" placeholder={label} value={fc[k] ?? ""} onChange={(e) => setFc({ ...fc, [k]: e.target.value })} />
        ))}
        <span className="text-muted-foreground">列名留空 = 自动识别（SKU / 可用库存 等常见表头）</span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy || !folder.trim()} onClick={preview}>预览最新文件</Button>
        <Button size="sm" disabled={busy} onClick={save}>保存</Button>
      </div>
      {pv && (
        <div className="text-xs space-y-1">
          <div>文件夹内 {pv.files.length} 个文件；选中：<b>{pv.picked ? `${pv.picked.name}（修改于 ${bj(pv.picked.modifiedTime)}）` : "无"}</b>
            {pv.picked && <>；sheet「{pv.sheet}」，表头第 {pv.header_row ?? "—"} 行，识别 {pv.count} 个 SKU，可用合计 {pv.total_available}</>}</div>
          {pv.notes.map((n, i) => <div key={i} className="text-amber-700">⚠ {n}</div>)}
          {!!pv.rows.length && <div className="font-mono max-h-40 overflow-auto whitespace-pre">{pv.rows.map((r) => `${r.wh_sku}  ${r.available}`).join("\n")}</div>}
        </div>
      )}
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
  ["min_days", "海外仓触发：可售天数 <", "负责人口径 10"],
  ["min_qty", "海外仓触发：listing 数量 <", "负责人口径 5"],
  ["reserve_per_sku", "每 SKU 海外仓预留", "负责人口径 5，不分配给 listing"],
  ["zero_sale_qty", "无销量 listing 保底数量", "待确认：默认 5，合计不超过可分配量 20%"],
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
