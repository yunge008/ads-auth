// 「从账户复制」：读源广告户全部 Product GMV Max 广告组（gmv-max-campaign-info），
// 勾选后逐个在目标广告户新建（gmv-max-adgroup-batch-create，每次 1 行）。
// 复制：名称 / 商品 / ROI / 预算 / identity_list / affiliate_posts_enabled。
// 不复制、标「手动」：全店商品组、手选视频组、商品 >50 的组。
import * as React from "react";
import * as XLSX from "xlsx";
import { Copy, Download, Play, HelpCircle, ArrowRightLeft } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { invokeFn } from "@/lib/api";

export type AdvOption = { id: string; name: string; shopId: string | null; bcId: string | null };

type InfoResp = {
  campaigns: { campaign_id: string; campaign_name: string; operation_status: string }[];
  infos: { campaign_id: string; ok: boolean; info?: Record<string, unknown>; error?: string }[];
  next_offset: number | null;
};
type ResultRow = { ok: boolean; campaign_id?: string; error?: string; notes?: string[] };

type Status = "manual" | "pending" | "running" | "ok" | "error";
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
  nameRoi: number | null;
  infoRoi: number;
  selected: boolean;
  status: Status;
  note: string;
  newId?: string;
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
  const m = name.match(/R(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)*)/);
  if (!m) return null;
  const v = Number(m[1].split("-").pop());
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
    nameRoi: roiFromName(name),
    selected: false,
    status: "pending",
    note: "",
  };
  const manual = (why: string) => Object.assign(row, { status: "manual" as Status, note: why });
  if (err) return manual(`读取失败：${err}`);
  if (info.product_specific_type === "ALL") return manual("全店商品组");
  if (info.product_video_specific_type === "CUSTOM_SELECTION") return manual("手选视频组");
  if (!ids.length) return manual("无商品");
  if (ids.length > 50) return manual(`商品 ${ids.length} 个 >50`);
  // 负责人决定：ROI 以名称为准，名称里解析不出才用 info
  if (row.nameRoi != null) {
    if (Math.abs(row.nameRoi - row.infoRoi) > 1e-6) row.note = `ROI 按名称 ${row.nameRoi}（info ${row.infoRoi}）`;
    row.roasBid = row.nameRoi;
  }
  if (!(row.roasBid > 0) || !(row.budget > 0)) return manual("ROI/预算缺失");
  row.selected = c.operation_status === "ENABLE";
  return row;
}

const statusLabel: Record<Status, string> = { manual: "手动", pending: "待复制", running: "复制中…", ok: "成功", error: "失败" };

export function CopyFromAccount({ advOptions }: { advOptions: AdvOption[] }) {
  const [srcId, setSrcId] = React.useState("");
  const [dstId, setDstId] = React.useState("");
  const [rows, setRows] = React.useState<CopyRow[]>([]);
  const [loading, setLoading] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [rawDump, setRawDump] = React.useState<unknown[]>([]);
  const [holder, setHolder] = React.useState<{ id: string | null; name: string | null; err?: string } | null>(null);
  const [authBusy, setAuthBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  type AuthCheck = { holder_advertiser_id: string | null; holder_advertiser_name: string | null; store_found: boolean };
  const checkAuth = React.useCallback(async (adv: string) => {
    if (!adv) return setHolder(null);
    setAuthBusy(true);
    try {
      const d = await invokeFn<AuthCheck>("gmv-max-exclusive-auth", { advertiser_id: adv, action: "check" });
      setHolder({ id: d.holder_advertiser_id, name: d.holder_advertiser_name, err: d.store_found ? undefined : "店铺未在列表中" });
    } catch (e) {
      setHolder({ id: null, name: null, err: (e as Error).message });
    } finally {
      setAuthBusy(false);
    }
  }, []);
  React.useEffect(() => { void checkAuth(dstId); }, [dstId, checkAuth]);

  const grantAuth = async () => {
    setConfirmOpen(false);
    setAuthBusy(true);
    try {
      await invokeFn("gmv-max-exclusive-auth", { advertiser_id: dstId, action: "grant" });
      toast.success("已切换独占授权");
    } catch (e) {
      toast.error(`切户失败：${(e as Error).message}`);
    } finally {
      setAuthBusy(false);
      void checkAuth(dstId);
    }
  };
  const dstHolds = !!dstId && holder?.id === dstId;

  const load = async () => {
    if (!srcId) return toast.error("请选择源广告户");
    setRows([]);
    setRawDump([]);
    const out: CopyRow[] = [];
    const dump: unknown[] = [];
    let offset: number | null = 0;
    try {
      while (offset != null) {
        setLoading(`读取中… ${out.length}`);
        const data: InfoResp = await invokeFn<InfoResp>("gmv-max-campaign-info", { advertiser_id: srcId, offset, limit: 30 }, { timeout: 140_000 });
        const byId = new Map(data.campaigns.map((c) => [c.campaign_id, c]));
        for (const i of data.infos) {
          dump.push(i);
          const c = byId.get(i.campaign_id) ?? { campaign_id: i.campaign_id, campaign_name: "", operation_status: "" };
          out.push(toRow(c, i.info, i.ok ? undefined : i.error));
        }
        if (!data.campaigns.length || !data.infos.length) break;
        offset = data.next_offset;
      }
      setRows(out);
      setRawDump(dump);
      toast.success(`读取 ${out.length} 个广告组`);
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

  const run = async () => {
    if (!dstId) return toast.error("请选择目标广告户");
    if (dstId === srcId) return toast.error("目标户不能和源户相同");
    if (!selectedCount) return;
    setRunning(true);
    let ok = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.selected || r.status !== "pending") continue;
      setRows((p) => p.map((x, idx) => (idx === i ? { ...x, status: "running" } : x)));
      try {
        const res = await invokeFn<{ results: ResultRow[] }>("gmv-max-adgroup-batch-create", {
          rows: [{
            advertiser_id: dstId,
            campaign_name: r.name,
            item_group_ids: r.itemGroupIds,
            roas_bid: r.roasBid,
            budget: r.budget,
            identity_list: r.identityList,
            ...(r.affiliatePostsEnabled != null ? { affiliate_posts_enabled: r.affiliatePostsEnabled } : {}),
            ...(r.accelTesting ? { accelerate_testing_for_new_videos: r.accelTesting } : {}),
          }],
        });
        const r0 = res.results?.[0];
        if (r0?.ok) ok++;
        setRows((p) => p.map((x, idx) => (idx === i ? {
          ...x, status: r0?.ok ? "ok" : "error", newId: r0?.campaign_id,
          note: r0?.ok ? [x.note, ...(r0.notes ?? [])].filter(Boolean).join("；") : (r0?.error ?? "未知错误"),
        } : x)));
      } catch (e) {
        setRows((p) => p.map((x, idx) => (idx === i ? { ...x, status: "error", note: (e as Error).message } : x)));
      }
    }
    setRunning(false);
    toast.success(`复制完成：成功 ${ok} / ${selectedCount}`);
  };

  const download = () => {
    const importAoa = [
      ["广告户ID", "广告组名称", "商品ID", "ROI", "预算", "开始时间", "结束时间", "视频账号JSON", "新素材优先测试", "源CampaignID"],
      ...rows.filter((r) => r.selected && r.status === "pending").map((r) => [
        dstId, r.name, r.itemGroupIds.join(","), r.roasBid, r.budget, "", "", JSON.stringify(r.identityList), r.accelTesting ?? "", r.srcId,
      ]),
    ];
    const aoa = [
      ["源CampaignID", "名称", "源状态", "商品数", "商品ID", "ROI", "预算", "identity数", "新素材测试", "状态", "新CampaignID", "备注"],
      ...rows.map((r) => [r.srcId, r.name, r.srcStatus, r.itemGroupIds.length, r.itemGroupIds.join(","), r.roasBid, r.budget,
        r.identityList.length, r.accelTesting ?? "", statusLabel[r.status], r.newId ?? "", r.note]),
    ];
    const wb = XLSX.utils.book_new();
    const importWs = XLSX.utils.aoa_to_sheet(importAoa);
    for (let r = 1; r < importAoa.length; r++) for (const c of [0, 2, 9]) {
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

  const advSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-72"><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>
        {advOptions.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}（{a.id}）</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          从账户复制
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="说明" className="text-muted-foreground"><HelpCircle className="h-4 w-4" /></button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs leading-relaxed">
                流程：读取源户 →（下载存档）→ 切户 → 复制；也可下载后用「Excel 批量新建」上传首个 sheet「导入」。
                复制名称、商品、ROI（按名称 R 后最后一个数，解析不出用 info）、预算、视频来源账号；新素材优先测试全开；立即开始，不开促销日、不开自动加预算。
                视频账号超过 20 个时先按原样建，被拒再保留前 20 个（店铺官方号优先），备注列出被去掉的账号。
                全店商品组、手选视频组、商品超过 50 个的组标「手动」不复制。
                切户后原持有户在该店铺的 GMV Max 广告组全部自动暂停。
                AI 素材（审核后发布）接口无此字段，建完需后台手动开。
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {advSelect(srcId, setSrcId, "源广告户")}
          <Button size="sm" variant="outline" onClick={load} disabled={!!loading || running}>
            <Copy className="h-4 w-4 mr-1" />{loading || "读取广告组"}
          </Button>
          <span aria-hidden className="text-muted-foreground">→</span>
          {advSelect(dstId, setDstId, "目标广告户")}
          {dstId && (
            <span className={`text-xs ${dstHolds ? "text-green-600" : "text-amber-600"}`} aria-live="polite">
              {authBusy ? "授权查询中…" : holder?.err ? `授权：${holder.err}` : dstHolds ? "已独占授权" : `授权在：${holder?.name ?? holder?.id ?? "无"}`}
            </span>
          )}
          {dstId && !dstHolds && !authBusy && (
            <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)} disabled={running || !!loading}>
              <ArrowRightLeft className="h-4 w-4 mr-1" />切户
            </Button>
          )}
          <Button size="sm" onClick={run} disabled={running || !!loading || !selectedCount || !dstId}>
            <Play className="h-4 w-4 mr-1" />{running ? "复制中…" : `复制（${selectedCount}）`}
          </Button>
          {rows.length > 0 && (
            <Button size="sm" variant="outline" onClick={download}><Download className="h-4 w-4 mr-1" />下载</Button>
          )}
        </div>
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
                  <TableHead className="text-right">商品</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">预算</TableHead>
                  <TableHead className="text-right">视频账号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>新ID / 备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={r.srcId}>
                    <TableCell>
                      <input type="checkbox" aria-label={`选择 ${r.name}`} checked={r.selected}
                        disabled={r.status !== "pending" || running} onChange={() => toggle(i)} />
                    </TableCell>
                    <TableCell className="text-xs">{r.name}</TableCell>
                    <TableCell className="text-xs">{r.srcStatus}</TableCell>
                    <TableCell className="text-right text-xs">{r.itemGroupIds.length}</TableCell>
                    <TableCell className="text-right text-xs">{Number.isFinite(r.roasBid) ? r.roasBid : ""}</TableCell>
                    <TableCell className="text-right text-xs">{Number.isFinite(r.budget) ? r.budget : ""}</TableCell>
                    <TableCell className="text-right text-xs">{r.identityList.length}</TableCell>
                    <TableCell className={`text-xs ${r.status === "ok" ? "text-green-600" : r.status === "error" ? "text-destructive" : r.status === "manual" ? "text-amber-600" : ""}`}>
                      {statusLabel[r.status]}
                    </TableCell>
                    <TableCell className="text-xs font-mono">{r.newId ?? ""}{r.newId && r.note ? " · " : ""}{r.note}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把店铺 GMV Max 独占授权切到 {dstId}？</AlertDialogTitle>
            <AlertDialogDescription>
              当前持有方 {holder?.name ?? holder?.id ?? "未知"} 在该店铺的所有 GMV Max 广告组会被 TikTok 自动暂停。
              {rows.length ? "" : " 还没读取源户广告组，切户后旧户可能读不到。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={grantAuth}>确认切户</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
