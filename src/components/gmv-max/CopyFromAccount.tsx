// 「从账户复制」：读源广告户全部 Product GMV Max 广告组（gmv-max-campaign-info），
// 勾选后逐个在目标广告户新建（服务端路由 /api/public/hooks/gmv-max-write action=create，每次 1 行）。
// 复制：名称 / 商品 / ROI / 预算 / identity_list / affiliate_posts_enabled。
// 不复制、标「手动」：手选视频组。全店商品组以 商品ID=ALL 复制。商品 >50 / 视频账号 >20 由服务端先降级建组再 update 补全。
import * as React from "react";
import * as XLSX from "xlsx";
import { Copy, Download, Play, RotateCcw, Users } from "lucide-react";
import { MultiSelect } from "@/components/MultiSelect";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callGmvMaxWrite } from "@/lib/api";
import { TargetPicker, useBcOptions } from "@/components/gmv-max/TargetPicker";
import { IdentityPanel, type IdentityRow } from "@/components/gmv-max/IdentityPanel";
import { CopyHelp } from "@/components/gmv-max/HelpTip";
import { useConnections } from "@/lib/store";
import { detailSheet, newBatchId, type DetailRow, type ProductResult } from "@/components/gmv-max/ImportHistory";

export type AdvOption = { id: string; name: string; shopId: string | null; bcId: string | null };

type InfoResp = {
  campaigns: { campaign_id: string; campaign_name: string; operation_status: string }[];
  infos: { campaign_id: string; ok: boolean; info?: Record<string, unknown>; error?: string }[];
  next_offset: number | null;
};
type ResultRow = {
  ok: boolean; partial?: boolean; campaign_id?: string; error?: string; notes?: string[]; products?: ProductResult[]; log_error?: string;
};

type Status = "manual" | "pending" | "running" | "ok" | "partial" | "error";
type CopyRow = {
  srcId: string;
  name: string;
  srcStatus: string;
  itemGroupIds: string[];
  roasBid: number;
  budget: number;
  identityList: unknown[];
  affiliatePostsEnabled?: boolean;
  accelTesting?: string;
  storeBc?: string;
  nameRoi: number | null;
  infoRoi: number;
  selected: boolean;
  spend3d: number | null; // 近 3 天消耗（null = 未取到）
  status: Status;
  note: string;
  newId?: string;
  products?: ProductResult[];
};

// info 可能是扁平对象，也可能包一层；取含 campaign_name 的那层。
function pickCampaign(info: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!info) return {};
  if ("campaign_name" in info || "item_group_ids" in info) return info;
  for (const v of Object.values(info)) {
    if (v && typeof v === "object" && !Array.isArray(v) && "campaign_name" in (v as object)) return v as Record<string, unknown>;
  }
  return info;
}
// 名称 R 后连续数字串的最后一个 = ROI：807-R3.4-5.5-7.5-5.0 → 5.0；观察六11.19-R5.0 → 5.0
function roiFromName(name: string): number | null {
  // R 前不能紧挨字母（AR333 不算，ROI 算）；带 % 的数不算（-3%券）；容忍 "4.4--5.7" 双横线
  const m = name.match(/(?:ROI|(?<![A-Za-z])R)(\d+(?:\.\d+)?(?:-+\d+(?:\.\d+)?(?![\d.%]))*)/);
  if (!m) return null;
  const v = Number(m[1].split(/-+/).pop());
  return v > 0 ? v : null;
}

function toRow(c: { campaign_id: string; campaign_name: string; operation_status: string }, raw: Record<string, unknown> | undefined, err?: string): CopyRow {
  const info = pickCampaign(raw);
  const name = String(info.campaign_name ?? c.campaign_name ?? "");
  const ids = Array.isArray(info.item_group_ids) ? (info.item_group_ids as unknown[]).map(String) : [];
  const row: CopyRow = {
    srcId: c.campaign_id,
    name,
    srcStatus: c.operation_status,
    itemGroupIds: ids,
    roasBid: Number(info.roas_bid),
    infoRoi: Number(info.roas_bid),
    budget: Number(info.budget),
    identityList: Array.isArray(info.identity_list) ? (info.identity_list as unknown[]) : [],
    affiliatePostsEnabled: typeof info.affiliate_posts_enabled === "boolean" ? info.affiliate_posts_enabled : undefined,
    accelTesting: "ON", // 负责人决定：新素材优先测试全开
    storeBc: info.store_authorized_bc_id != null ? String(info.store_authorized_bc_id) : undefined,
    nameRoi: roiFromName(name),
    selected: false,
    spend3d: null,
    status: "pending",
    note: "",
  };
  const manual = (why: string) => Object.assign(row, { status: "manual" as Status, note: why });
  if (err) return manual(`读取失败：${err}`);
  if (info.product_video_specific_type === "CUSTOM_SELECTION") return manual("手选视频组");
  if (info.product_specific_type === "ALL") {
    row.itemGroupIds = ["ALL"]; // 全店商品组：建组时 product_specific_type=ALL
  } else if (!ids.length) return manual("无商品");
  // 负责人决定：ROI 以名称为准，名称里解析不出才用 info
  if (row.nameRoi != null) {
    if (Math.abs(row.nameRoi - row.infoRoi) > 1e-6) row.note = `ROI 按名称 ${row.nameRoi}（info ${row.infoRoi}）`;
    row.roasBid = row.nameRoi;
  }
  if (!(row.roasBid > 0) || !(row.budget > 0)) return manual("ROI/预算缺失");
  row.selected = c.operation_status === "ENABLE";
  return row;
}

const FILTER_SPEND = "近3天有消耗";
const FILTER_ENABLE = "启用中";
const matchFilter = (r: CopyRow, f: string[]) =>
  !f.length || (f.includes(FILTER_SPEND) && (r.spend3d ?? 0) > 0) || (f.includes(FILTER_ENABLE) && r.srcStatus === "ENABLE");
// 筛选决定勾选：符合任一所选条件的可复制组勾上，其余取消
const applyFilter = (rows: CopyRow[], f: string[]) =>
  rows.map((r) => (r.status === "pending" ? { ...r, selected: matchFilter(r, f) } : r));

const statusLabel: Record<Status, string> = { manual: "手动", pending: "待复制", running: "复制中…", ok: "成功", partial: "已建·需处理", error: "失败" };

// 未成功（失败 / 已建但未与源组完全一致 / 校验未通过）清单：执行后常驻显示，直到下次读取/上传
export function FailureList({ items }: { items: { key: string; name: string; label: string; reason: string }[] }) {
  if (!items.length) return null;
  return (
    <div role="alert" className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs space-y-1 max-h-60 overflow-auto">
      <div className="font-medium text-destructive">未成功 {items.length} 个</div>
      {items.map((it) => (
        <div key={it.key}><span className="font-medium">{it.name}</span> · {it.label} · <span className="break-all">{it.reason}</span></div>
      ))}
    </div>
  );
}

export function CopyFromAccount({ advOptions, onDone }: { advOptions: AdvOption[]; onDone?: () => void }) {
  const [srcId, setSrcId] = React.useState("");
  const [srcBcSel, setSrcBcSel] = React.useState("");
  const [rows, setRows] = React.useState<CopyRow[]>([]);
  const rowsState = rows;
  const [dstId, setDstId] = React.useState("");
  const [dstBc, setDstBc] = React.useState("");
  const [filters, setFilters] = React.useState<string[]>([]);
  const [showAll, setShowAll] = React.useState(false);
  const changeFilters = (f: string[]) => { setFilters(f); setRows((p) => applyFilter(p, f)); };

  // ---- 视频账号：来源 BC / 目标 BC 授权对照，只能勾目标 BC 有的 ----
  const bcOpts = useBcOptions(dstId);
  const dstBcName = bcOpts.find((b) => b.bcId === dstBc)?.bcName ?? "";
  const advName = (id: string) => advOptions.find((a) => a.id === id)?.name ?? "";
  const { connections } = useConnections();
  const bcNameOf = (id: string) => connections.find((c) => c.bc_id === id)?.bc_name ?? "";
  const [srcIdents, setSrcIdents] = React.useState<Set<string> | null>(null);
  const [dstIdents, setDstIdents] = React.useState<Set<string> | null>(null);
  const [identNames, setIdentNames] = React.useState<Record<string, string>>({});
  const [identChecked, setIdentChecked] = React.useState<Set<string>>(new Set());
  const [identLoading, setIdentLoading] = React.useState(false);
  const [identTypes, setIdentTypes] = React.useState<Record<string, string>>({});
  const [identTick, setIdentTick] = React.useState(0); // 「读取视频账号」按钮触发
  // 来源 BC = 源户 BC 下拉所选（读取源组、查来源 BC 视频账号都用它）
  const srcBc = srcBcSel;
  const identItems: IdentityRow[] = React.useMemo(() => {
    const m = new Map<string, IdentityRow>();
    for (const r of rows) {
      if (!(r.selected || r.status === "ok" || r.status === "partial" || r.status === "error")) continue;
      for (const x of r.identityList as Record<string, unknown>[]) {
        const id = String(x.identity_id ?? "");
        if (!id) continue;
        const it = m.get(id) ?? { identity_id: id, identity_type: String(x.identity_type ?? ""), name: identNames[id] ?? "",
          groups: 0, inSrc: srcIdents ? srcIdents.has(id) : null, inDst: dstIdents ? dstIdents.has(id) : null };
        it.groups++;
        m.set(id, it);
      }
    }
    // 两边 BC 查到的账号也列出（没读组时只看授权对照，组数 0）
    for (const id of [...(srcIdents ?? []), ...(dstIdents ?? [])]) {
      if (m.has(id)) continue;
      m.set(id, { identity_id: id, identity_type: identTypes[id] ?? "", name: identNames[id] ?? "", groups: 0,
        inSrc: srcIdents ? srcIdents.has(id) : null, inDst: dstIdents ? dstIdents.has(id) : null });
    }
    return Array.from(m.values()).sort((a, b) => Number(b.inDst !== false) - Number(a.inDst !== false) || b.groups - a.groups);
  }, [rows, srcIdents, dstIdents, identNames, identTypes]);
  React.useEffect(() => {
    // 自动：读完组且两边户+BC 都选了；手动：点「读取视频账号」（identTick 变化），哪边选了查哪边
    if (!identTick && (!rows.length || !srcId || !dstId || !dstBc)) return;
    if (!(srcId && srcBc) && !(dstId && dstBc)) return;
    let stop = false;
    setIdentLoading(true);
    type Resp = { identities: { identity_id: string; identity_type: string; name: string; product_gmv_max_available: boolean }[]; names?: Record<string, string> };
    const q = (adv: string, bc: string) => adv && bc
      ? callGmvMaxWrite<Resp>({ action: "identities", advertiser_id: adv, bc_id: bc }).catch(() => null)
      : Promise.resolve(null);
    Promise.all([q(srcId, srcBc), q(dstId, dstBc)]).then(([s1, d1]) => {
      if (stop) return;
      const names: Record<string, string> = {};
      Object.assign(names, s1?.names ?? {}, d1?.names ?? {});
      for (const x of [...(s1?.identities ?? []), ...(d1?.identities ?? [])]) if (x.name) names[x.identity_id] = x.name;
      setIdentNames(names);
      const types: Record<string, string> = {};
      for (const x of [...(s1?.identities ?? []), ...(d1?.identities ?? [])]) types[x.identity_id] = x.identity_type;
      setIdentTypes(types);
      setSrcIdents(s1 ? new Set(s1.identities.map((x) => x.identity_id)) : null);
      const dst = d1 ? new Set(d1.identities.filter((x) => x.product_gmv_max_available).map((x) => x.identity_id)) : null;
      setDstIdents(dst);
      // 默认勾选：目标 BC 有授权的（查询失败时全部勾上，交给建组时校验）
      const all = rows.flatMap((r) => (r.identityList as Record<string, unknown>[]).map((x) => String(x.identity_id ?? "")));
      setIdentChecked(new Set(all.filter((id) => !dst || dst.has(id))));
      if (!s1 && !d1) toast.error("读取视频账号失败");
    }).finally(() => { if (!stop) setIdentLoading(false); });
    return () => { stop = true; };
  }, [rows.length, srcId, dstId, dstBc, srcBc, identTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const identsFor = (r: CopyRow) => (r.identityList as Record<string, unknown>[]).filter((x) => identChecked.has(String(x.identity_id ?? "")));

  // 目标户店铺里「可投且不在任何启用中 GMV Max 组」的商品
  const [loading, setLoading] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [rawDump, setRawDump] = React.useState<unknown[]>([]);
  const [holder, setHolder] = React.useState<{ id: string | null; name: string | null; err?: string } | null>(null);
  const [authBusy, setAuthBusy] = React.useState(false);

  type AuthCheck = { holder_advertiser_id: string | null; holder_advertiser_name: string | null; store_found: boolean };
  const checkAuth = React.useCallback(async (adv: string) => {
    if (!adv) return setHolder(null);
    setAuthBusy(true);
    try {
      const d = await callGmvMaxWrite<AuthCheck>({ action: "auth_check", advertiser_id: adv });
      setHolder({ id: d.holder_advertiser_id, name: d.holder_advertiser_name, err: d.store_found ? undefined : "店铺未在列表中" });
    } catch (e) {
      setHolder({ id: null, name: null, err: (e as Error).message });
    } finally {
      setAuthBusy(false);
    }
  }, []);
  React.useEffect(() => { void checkAuth(dstId); }, [dstId, checkAuth]);

  const dstHolds = !!dstId && holder?.id === dstId;

  const load = async () => {
    if (!srcId) return toast.error("请选择源广告户");
    if (!srcBcSel) return toast.error("先选源广告户的 BC");
    setRows([]);
    setRawDump([]);
    const out: CopyRow[] = [];
    const dump: unknown[] = [];
    let offset: number | null = 0;
    try {
      while (offset != null) {
        setLoading(`读取中… ${out.length}`);
        // 按导入目标 BC 对应连接的授权读取（不同 BC 读到的视频账号集合不同）
        const data: InfoResp = await callGmvMaxWrite<InfoResp>({ action: "info", advertiser_id: srcId, bc_id: srcBcSel, offset, limit: 20 });
        const byId = new Map(data.campaigns.map((c) => [c.campaign_id, c]));
        for (const i of data.infos) {
          dump.push(i);
          const c = byId.get(i.campaign_id) ?? { campaign_id: i.campaign_id, campaign_name: "", operation_status: "" };
          out.push(toRow(c, i.info, i.ok ? undefined : i.error));
        }
        if (!data.campaigns.length || !data.infos.length) break;
        offset = data.next_offset;
      }
      // 近 3 天消耗：有消耗的组默认按消耗筛，全为 0 再按状态筛
      let spendErr = "";
      try {
        setLoading("读取近 3 天消耗…");
        const sp = await callGmvMaxWrite<{ campaigns: Record<string, number> }>({ action: "spend", advertiser_id: srcId, days: 3 });
        for (const r of out) r.spend3d = Math.round((sp.campaigns[r.srcId] ?? 0) * 100) / 100;
      } catch (e) {
        spendErr = (e as Error).message;
      }
      const anySpend = out.some((r) => (r.spend3d ?? 0) > 0);
      const nextFilter = anySpend ? [FILTER_SPEND] : [FILTER_ENABLE];
      setFilters(nextFilter);
      setRows(applyFilter(out, nextFilter));
      setRawDump(dump);
      if (spendErr) toast.error(`近 3 天消耗读取失败，按启用状态筛：${spendErr}`);
      else toast.success(`读取 ${out.length} 个广告组`);
    } catch (e) {
      setRows(out);
      setRawDump(dump);
      toast.error(`读取失败：${(e as Error).message}`);
    } finally {
      setLoading("");
    }
  };

  const toggle = (i: number) => setRows((p) => p.map((r, idx) => (idx === i && r.status === "pending" ? { ...r, selected: !r.selected } : r)));
  const copyable = rows.filter((r) => r.status === "pending");
  const allSelected = copyable.length > 0 && copyable.every((r) => r.selected);
  const toggleAll = () => setRows((p) => p.map((r) => (r.status === "pending" ? { ...r, selected: !allSelected } : r)));
  const selectedCount = rows.filter((r) => r.selected && r.status === "pending").length;
  const failedCount = rows.filter((r) => r.status === "error").length;
  const visible = rows.filter((r) => showAll || matchFilter(r, filters) || r.status !== "pending");

  // retryFailed：把上次失败的组恢复为待复制并只勾它们，直接再跑一遍（不用重新读取）
  const run = async (retryFailed = false) => {
    if (!dstId) return toast.error("请选择目标广告户");
    if (dstId === srcId) return toast.error("目标户不能和源户相同");
    if (!dstBc) return toast.error("目标户没有可用的 BC");
    let rows = rowsState;
    if (retryFailed) {
      rows = rowsState.map((r) => (r.status === "error"
        ? { ...r, status: "pending" as Status, selected: true, note: "", newId: undefined, products: undefined }
        : r.status === "pending" ? { ...r, selected: false } : r));
      setRows(rows);
    }
    // 规则（负责人）：一个商品只能在一个启用组；全店组(ALL)转为指定商品 = 它近 30 天实际投到的商品，
    // 去掉本次其他组已有的商品，避免和其他组冲突（店铺有其他启用组时 API 也建不了 ALL 组）
    const takenByOthers = new Set(rows.filter((r) => r.status === "ok" || r.status === "partial" || (r.selected && r.status === "pending"))
      .filter((r) => !(r.itemGroupIds.length === 1 && r.itemGroupIds[0] === "ALL")).flatMap((r) => r.itemGroupIds));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.selected || r.status !== "pending" || !(r.itemGroupIds.length === 1 && r.itemGroupIds[0] === "ALL")) continue;
      try {
        const d = await callGmvMaxWrite<{ products: Record<string, number> }>({ action: "campaign_products", advertiser_id: srcId, campaign_id: r.srcId, days: 30 });
        const all = Object.keys(d.products);
        const keep = all.filter((id) => !takenByOthers.has(id));
        const note = `全店→指定 ${keep.length} 个${all.length - keep.length ? `（去重 ${all.length - keep.length}）` : ""}`;
        rows = rows.map((x, idx) => (idx === i ? (keep.length ? { ...x, itemGroupIds: keep, note } : { ...x, status: "error" as Status, note: `${note}，无可建商品` }) : x));
      } catch (e) {
        rows = rows.map((x, idx) => (idx === i ? { ...x, status: "error" as Status, note: `全店组读取商品失败：${(e as Error).message}` } : x));
      }
    }
    setRows(rows);
    const selectedCount = rows.filter((r) => r.selected && r.status === "pending").length;
    if (!selectedCount) return;
    setRunning(true);
    let ok = 0;
    let logErr = "";
    const batchId = newBatchId();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.selected || r.status !== "pending") continue;
      setRows((p) => p.map((x, idx) => (idx === i ? { ...x, status: "running" } : x)));
      try {
        const r0 = await callGmvMaxWrite<ResultRow>({
          action: "create",
          row: {
            advertiser_id: dstId,
            campaign_name: r.name,
            item_group_ids: r.itemGroupIds,
            roas_bid: r.roasBid,
            budget: r.budget,
            identity_list: identsFor(r),
            ...(r.affiliatePostsEnabled != null ? { affiliate_posts_enabled: r.affiliatePostsEnabled } : {}),
            ...(r.accelTesting ? { accelerate_testing_for_new_videos: r.accelTesting } : {}),
            store_authorized_bc_id: dstBc,
          },
          log: {
            batch_id: batchId, kind: "copy", source: `源户 ${srcId}`, source_campaign_id: r.srcId,
            source_advertiser_id: srcId, source_advertiser_name: advName(srcId), source_bc_id: srcBc,
            source_bc_name: bcNameOf(srcBc), advertiser_name: advName(dstId), bc_name: dstBcName,
          },
        });
        if (r0?.log_error) logErr = r0.log_error;
        if (r0?.ok && !r0.partial) ok++;
        setRows((p) => p.map((x, idx) => (idx === i ? {
          ...x, status: r0?.ok ? (r0.partial ? "partial" : "ok") : "error", newId: r0?.campaign_id, products: r0?.products,
          note: r0?.ok ? [x.note, ...(r0.notes ?? [])].filter(Boolean).join("；") : (r0?.error ?? "未知错误"),
        } : x)));
      } catch (e) {
        setRows((p) => p.map((x, idx) => (idx === i ? { ...x, status: "error", note: (e as Error).message } : x)));
      }
    }
    setRunning(false);
    onDone?.();
    if (logErr) toast.error(`导入记录：${logErr}`, { duration: 15000 });
    if (ok === selectedCount) toast.success(`复制完成：全部成功 ${ok} / ${selectedCount}`);
    else toast.error(`复制完成：成功 ${ok} / ${selectedCount}，其余见「未成功」列表`, { duration: 15000 });
  };

  const download = () => {
    const importAoa = [
      ["广告户ID", "广告组名称", "商品ID", "ROI", "预算", "开始时间", "结束时间", "视频账号JSON", "新素材优先测试", "源CampaignID", "店铺授权BC"],
      ...rows.filter((r) => r.selected && r.status === "pending").map((r) => [
        dstId, r.name, r.itemGroupIds.join(","), r.roasBid, r.budget, "", "", JSON.stringify(r.identityList), r.accelTesting ?? "", r.srcId, dstBc,
      ]),
    ];
    const aoa = [
      ["源CampaignID", "名称", "源状态", "近3天消耗", "商品数", "商品ID", "ROI", "预算", "identity数", "新素材测试", "状态", "新CampaignID", "备注"],
      ...rows.map((r) => [r.srcId, r.name, r.srcStatus, r.spend3d ?? "", r.itemGroupIds.length, r.itemGroupIds.join(","), r.roasBid, r.budget,
        r.identityList.length, r.accelTesting ?? "", statusLabel[r.status], r.newId ?? "", r.note]),
    ];
    const wb = XLSX.utils.book_new();
    const importWs = XLSX.utils.aoa_to_sheet(importAoa);
    for (let r = 1; r < importAoa.length; r++) for (const c of [0, 2, 9, 10]) {
      const cell = importWs[XLSX.utils.encode_cell({ r, c })];
      if (cell) { cell.t = "s"; cell.z = "@"; }
    }
    XLSX.utils.book_append_sheet(wb, importWs, "导入");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "复制");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["campaign_id", "info_json"], ...rawDump.map((d) => {
      const x = d as { campaign_id: string };
      return [x.campaign_id, JSON.stringify(d).slice(0, 32000)];
    })]), "原始info");
    XLSX.writeFile(wb, `gmv-max-复制-${srcId}-${Date.now()}.xlsx`);
  };

  // 复制结果：执行过的组 + 逐商品明细（执行前按钮禁用）
  const doneRows = rows.filter((r) => r.status === "ok" || r.status === "partial" || r.status === "error");
  const downloadResult = () => {
    const done = doneRows;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["源CampaignID", "名称", "状态", "新CampaignID", "备注"],
      ...done.map((r) => [r.srcId, r.name, statusLabel[r.status], r.newId ?? "", r.note]),
    ]), "结果");
    {
      const detail: DetailRow[] = done.flatMap((r) => {
        const base = {
          campaign_name: r.name, new_campaign_id: r.newId ?? "", source_campaign_id: r.srcId,
          source_advertiser_id: srcId, source_advertiser_name: advName(srcId), source_bc_id: srcBc, source_bc_name: bcNameOf(srcBc),
          advertiser_id: dstId, advertiser_name: advName(dstId), bc_id: dstBc, bc_name: dstBcName,
          group_status: statusLabel[r.status], group_note: r.note,
        };
        return r.products?.length
          ? r.products.map((p) => ({ ...base, item_group_id: p.item_group_id, status: p.status, reason: p.reason }))
          : r.itemGroupIds.map((id) => ({ ...base, item_group_id: id, status: r.status === "error" ? "失败" : "成功", reason: r.status === "error" ? r.note : "" }));
      });
      XLSX.utils.book_append_sheet(wb, detailSheet(detail), "商品明细");
    }
    XLSX.writeFile(wb, `gmv-max-复制结果-${dstId}-${Date.now()}.xlsx`);
  };


  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          从账户复制
          <CopyHelp />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 第一行：源户 / 源 BC → 目标户 / 目标 BC（+ 店铺授权状态） */}
        <div className="flex flex-wrap items-center gap-2">
          <TargetPicker advOptions={advOptions} advertiserId={srcId} onAdvertiserChange={setSrcId}
            bcId={srcBcSel} onBcChange={setSrcBcSel} advLabel="源广告户" disabled={running || !!loading} />
          <span aria-hidden className="text-muted-foreground">→</span>
          <TargetPicker advOptions={advOptions} advertiserId={dstId} onAdvertiserChange={setDstId}
            bcId={dstBc} onBcChange={setDstBc} disabled={running} />
          {dstId && (
            <span className={`text-xs ${dstHolds ? "text-green-600" : "text-amber-600"}`} aria-live="polite">
              {authBusy ? "授权查询中…" : holder?.err ? `授权：${holder.err}` : dstHolds ? "店铺已授权为新账号" : `店铺授权在：${holder?.name ?? holder?.id ?? "无"}`}
            </span>
          )}
        </div>
        {/* 第二行：按操作顺序 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={!!loading || running || !srcId || !srcBcSel}>
            <Copy className="h-4 w-4 mr-1" />{loading || "读取广告组"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setIdentTick((t) => t + 1)}
            disabled={identLoading || !((srcId && srcBc) || (dstId && dstBc))} aria-label="读取来源/目标 BC 的视频账号">
            <Users className="h-4 w-4 mr-1" />{identLoading ? "读取中…" : "读取视频账号"}
          </Button>
          <Button size="sm" variant="outline" onClick={download} disabled={!rows.length} aria-label="下载读取的广告组（含可直接导入的 sheet）">
            <Download className="h-4 w-4 mr-1" />下载
          </Button>
          <Button size="sm" onClick={() => run()} disabled={running || !!loading || !selectedCount || !dstId || !dstBc}>
            <Play className="h-4 w-4 mr-1" />{running ? "复制中…" : `复制（${selectedCount}）`}
          </Button>
          {failedCount > 0 && (
            <Button size="sm" variant="outline" onClick={() => run(true)} disabled={running || !!loading || !dstId || !dstBc}>
              <RotateCcw className="h-4 w-4 mr-1" />重试失败（{failedCount}）
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={downloadResult} disabled={running || !doneRows.length} aria-label="下载复制结果">
            <Download className="h-4 w-4 mr-1" />下载结果
          </Button>
        </div>
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="w-56" aria-label="筛选广告组">
              <MultiSelect label="筛选" options={[FILTER_SPEND, FILTER_ENABLE]} value={filters} onChange={changeFilters} placeholder="不筛选" />
            </div>
            <label className="flex items-center gap-1 text-muted-foreground">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />显示未命中筛选的组
            </label>
            <span className="text-muted-foreground">{visible.length} / {rows.length}</span>
          </div>
        )}
        <IdentityPanel items={identItems} checked={identChecked} loading={identLoading}
          srcLabel={`来源 BC ${bcNameOf(srcBc)} ${srcBc}`} dstLabel={`目标 BC ${dstBcName} ${dstBc}`}
          onToggle={(id, v) => setIdentChecked((p) => { const n = new Set(p); if (v) n.add(id); else n.delete(id); return n; })} />
        <FailureList items={rows.filter((r) => r.status === "error" || r.status === "partial" || (r.status === "manual" && r.srcStatus === "ENABLE"))
          .map((r) => ({ key: r.srcId, name: r.name, label: statusLabel[r.status], reason: r.note }))} />
        {rows.length > 0 && (
          <div className="max-h-[480px] overflow-auto border rounded">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input type="checkbox" aria-label="全选可复制" checked={allSelected} onChange={toggleAll} disabled={running} />
                  </TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>源状态</TableHead>
                  <TableHead className="text-right">近3天消耗</TableHead>
                  <TableHead className="text-right">商品</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">预算</TableHead>
                  <TableHead className="text-right">视频账号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>新ID / 备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => [r, i] as const).filter(([r]) => visible.includes(r)).map(([r, i]) => (
                  <TableRow key={r.srcId}>
                    <TableCell>
                      <input type="checkbox" aria-label={`选择 ${r.name}`} checked={r.selected}
                        disabled={r.status !== "pending" || running} onChange={() => toggle(i)} />
                    </TableCell>
                    <TableCell className="text-xs">{r.name}</TableCell>
                    <TableCell className="text-xs">{r.srcStatus}</TableCell>
                    <TableCell className="text-right text-xs">{r.spend3d ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs">{r.itemGroupIds.length}</TableCell>
                    <TableCell className="text-right text-xs">{Number.isFinite(r.roasBid) ? r.roasBid : ""}</TableCell>
                    <TableCell className="text-right text-xs">{Number.isFinite(r.budget) ? r.budget : ""}</TableCell>
                    <TableCell className={`text-right text-xs ${identsFor(r).length < r.identityList.length ? "text-amber-600" : ""}`}>
                      {identsFor(r).length < r.identityList.length ? `${identsFor(r).length}/${r.identityList.length}` : r.identityList.length}
                    </TableCell>
                    <TableCell className={`text-xs ${r.status === "ok" ? "text-green-600" : r.status === "error" ? "text-destructive" : r.status === "manual" || r.status === "partial" ? "text-amber-600" : ""}`}>
                      {statusLabel[r.status]}
                    </TableCell>
                    <TableCell className="text-xs" title={r.note || undefined}>
                      {r.newId && <span className="font-mono">{r.newId}</span>}
                      {r.note && <span className={`block truncate max-w-md ${r.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>{r.note}</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
