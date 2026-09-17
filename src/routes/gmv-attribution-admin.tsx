// GMV 归因 · 管理视图：全量进度板（含离职/6 桶口径）+ Excel 上传 + 审查与飞书回写。
import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RotateCw, RefreshCw, Users, Target as TargetIcon, ArrowLeftRight, Upload, Download, HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { ProgressBoard } from "@/components/attribution/ProgressBoard";
import { DetailTable } from "@/components/attribution/DetailTable";
import { ReviewPanel } from "@/components/attribution/ReviewPanel";
import { UploadView, type Viewing } from "@/components/attribution/UploadView";
import { SiteMismatchTable } from "@/components/attribution/SiteMismatchTable";
import { DiagnosePanel } from "@/components/attribution/DiagnosePanel";
import { ReconcilePanel } from "@/components/attribution/ReconcilePanel";
import { DataPrepPanel } from "@/components/attribution/DataPrepPanel";
import { IdentityPreviewPanel } from "@/components/attribution/IdentityPreviewPanel";
import { TypeMixPanel } from "@/components/attribution/TypeMixPanel";
import {
  type AttributionReport,
  type DetailRow,
  type DrillFilter,
  type RunMeta,
  exportApi,
  feishuAction,
  snapshotApi,
  syncCreators,
  uploadApi,
} from "@/lib/attributionApi";
import { attributionView } from "@/lib/attributionView";


/**
 * 「数据准备」三个按钮的说明文案。写在按钮右侧的「?」里，不占版面。
 * 口径提醒：这三个按钮只更新基础数据；归因结果每次出报表时按当下数据现算，不需要重传广告表。
 */
const SYNC_HELP: Record<"creators" | "targets" | "handovers" | "progress" | "export", { title: string; lines: string[] }> = {
  creators: {
    title: "同步达人登记",
    lines: [
      "读飞书三处登记，重建 creator_registry（登记原始行）与 creator_ownership（达人→BD 归属）两张表。",
      "【一】建联表（主表格，各 BD 一个「建联-姓名」sheet，按「同事表配置」里的 sheet 名找，含离职同事）",
      "读 A2:Z 全部行，取这几列：",
      "· B 列 发样日期 → 发样动作日",
      "· C 列 地区/店铺 → 站点（必须填英文简写 PH / TH / VN / MX-AR…，填汉字永远匹配不上）",
      "· D 列 用户名 → 用户名匹配键",
      "· E 列 昵称 → 昵称匹配键（GMV MAX 导出里的「TikTok账号」对的就是它）",
      "· K 列 SKU → 登记 SKU（仅记录）",
      "· N 列 登记日期 → 回收素材动作日（保护期和归属转移看的就是这一列）",
      "· P 列 VID → VID 强归因（这一列必须设成「文本」格式，设成数字会丢精度、整行作废）",
      "· 「粉丝量/粉丝数/followers」列按表头自动找列位，不写死列号（仅记录，前台暂不展示）",
      "· BD 是谁不看表里的 A 列，按 sheet 名对应的同事算",
      "【二】「授权记录」sheet（同一个主表格，历史归档，读 M3:S）",
      "· M 列 BD（留空记成「原数据」） · N 列 登记日期 · O 列 国家 · P 列 达人名字（当昵称用） · Q 列 VID · S 列 SKU",
      "这张表没有用户名、也没有发样日期，所以归档行只能靠昵称和 VID 归因。",
      "【三】剪辑表（另一个表格 FEISHU_EDITOR_SPREADSHEET_TOKEN，每个剪辑一个 sheet，读 A2:H）",
      "· B 列 同事（必须等于 sheet 对应的姓名，不等的行直接跳过） · C 列 日期 · D 列 国家 · E 列 账号（当昵称用） · F 列 SKU · G 列 VID",
      "剪辑行只用于 VID 强归因，没有 VID 的行直接跳过。",
      "【归属怎么判】每次全量重建（按 sheet 先删后插）。同一个达人被多人登记时：谁最早登记谁拥有；同一个人再登记只刷新「最近有效动作日」；换一个 BD 登记时，距最近有效动作日满 90 自然天归属才转移，未满就是抢注无效、归属不变，并记一条审查项到「审查与回写」。",
      "同一个字符串既是 A 的昵称又是 B 的用户名且归属不同 → 记 KEYTYPE_CONFLICT，匹配时昵称归属优先。",
      "同步完刷新报表即可生效，不用重传广告表。",
      "每晚北京 23:00 自动同步一次（在 23:30 的归因快照之前）；飞书刚改完要马上生效就手动点一次。",
    ],
  },
  targets: {
    title: "同步 GMV 目标",
    lines: [
      "读飞书「绩效配置表」A–F 列（月份 / 姓名 / 角色 / 目标金额 / 备注），覆盖写入月度目标。",
      "只决定进度条的分母，不影响归因结果。",
      "每晚北京 23:00 自动同步一次；飞书刚改完要马上生效就手动点一次。",
    ],
  },
  handovers: {
    title: "同步站点交接",
    lines: [
      "读飞书「绩效配置表」H–L 列（站点 / 原BD / 新BD / 交接日期 / 备注），全量重建交接记录。",
      "交接日只是「允许转移」的起点：真正的转移日是新 BD 在交接日之后，对那个具体达人第一次登记/发样的日期。",
      "发布时间早于转移日的素材仍算原 BD；新 BD 没接手过的达人，这条交接对他不生效。VID 强匹配不受交接影响。",
      "每晚北京 23:00 自动同步一次；飞书刚改完要马上生效就手动点一次。",
    ],
  },
  progress: {
    title: "回写飞书进度",
    lines: [
      "把当前月份快照的结果**追加**写进飞书主表格的「绩效统计记录」sheet（从第一个空行往下加，不覆盖历史）。",
      "一个同事 × 一个站点一行，另外末尾补两行汇总：「商品卡」和「未归因」。",
      "列顺序（A–S）：",
      "A 回写时间 · B 月份 · C 站点 · D 同事 · E 角色（BD/剪辑）",
      "F GMV(USD) · G 消耗(USD) · H 订单 · I 目标 · J 进度%",
      "K VID匹配GMV · L 昵称匹配GMV · M 商品卡GMV · N 未归因GMV",
      "O–R 预留空列 · S 状态（离职的人标「已离职」）",
      "「商品卡」行只填 F/G/H 与 M，「未归因」行只填 F/G/H 与 N，C、I–L 留空。",
      "只写不读，不会改动飞书里已有的行；同一个月点多次会追加多份，注意别重复点。",
    ],
  },
  export: {
    title: "导出唯一VID汇总",
    lines: [
      "导出当前月份的 Excel，一行 = 一个「站点 × VID × 商品ID」，跨文件跨天已合并求和。",
      "达人昵称取该 VID 出现次数最多的那个写法；SKU 由商品ID 关联 sku_product_map 得到。",
      "金额已按归并时的汇率折成 USD；ROI / CTR / CVR 用汇总后的分子分母重算，不是平均值。",
      "列顺序：站点 · 月份 · VID · 达人昵称 · 归属人 · 角色 · 归属类别 · 匹配方式 · PID · SKU · GMV · 消耗 · 订单量 · ROI · PV · 点击 · CTR · CVR",
      "归属四列来自该月最新快照：一个 VID 可能有多条判定（视频/直播…），取金额最大的那条。没跑过快照时这四列为空。",
      "这是与本地 Excel 对账用的底表——站点、VID、归属人三列齐全，可以直接和手工结果逐行比。",
      "大月份二十几万行：下载分页进行（每页两万），文件生成是浏览器本地做的，十几秒属正常，期间别关页面。",
      "VID 以文本写入，不会被 Excel 转成科学计数法丢精度。",
    ],
  },
};

function SyncHelp({ kind }: { kind: keyof typeof SYNC_HELP }) {
  const help = SYNC_HELP[kind];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" aria-label={`${help.title}说明`}>
          <HelpCircle className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 text-xs space-y-1.5">
        <div className="font-medium text-sm">{help.title}</div>
        {help.lines.map((l, i) => <div key={i} className="text-muted-foreground leading-relaxed">{l}</div>)}
      </PopoverContent>
    </Popover>
  );
}

const VID_SUMMARY_HEADER = [
  "站点", "月份", "VID", "达人昵称",
  "归属人", "角色", "归属类别", "匹配方式",
  "PID", "SKU", "GMV", "消耗", "订单量", "ROI", "PV", "点击", "CTR", "CVR",
];

export const Route = createFileRoute("/gmv-attribution-admin")({
  head: () => ({ meta: [{ title: "GMV 归因·管理 - TikTok授权工具" }] }),
  component: GmvAttributionAdminPage,
});

/** 快照历史：点开才加载，展示这个月跑过哪些快照、谁触发的、各自的口径量级。 */
function RunHistory({ month }: { month: string }) {
  const [runs, setRuns] = React.useState<RunMeta[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const load = async () => {
    if (runs || loading) return;
    setLoading(true);
    try {
      const r = await snapshotApi.runs(month, 20);
      setRuns(r.runs ?? []);
    } catch (e) {
      toast.error(`加载快照历史失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };
  // 换月份时清空，避免看到上一个月的历史
  React.useEffect(() => { setRuns(null); }, [month]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={load}>快照历史</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[30rem] text-xs">
        {loading ? (
          <div className="text-muted-foreground">加载中…</div>
        ) : !runs?.length ? (
          <div className="text-muted-foreground">该月还没有快照记录</div>
        ) : (
          <div className="space-y-1">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 border-b last:border-0 py-1">
                <span className="tabular-nums">{new Date(r.finished_at ?? r.started_at).toLocaleString()}</span>
                <span className="text-muted-foreground">
                  {r.source === "CRON" ? "每晚自动" : r.source === "UPLOAD" ? "上传后" : "手动"}
                  {r.triggered_by ? `·${r.triggered_by}` : ""}
                </span>
                <span className={r.status === "READY" ? "" : "text-destructive"}>
                  {r.status === "READY" ? `${r.staff_count} 人 / $${Math.round(r.total_gmv).toLocaleString()}` : r.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MonthlyView() {
  // 视图状态放模块级 store：切标签页/切路由回来不用重查
  const views = React.useSyncExternalStore(
    attributionView.subscribe,
    attributionView.getSnapshot,
    attributionView.getServerSnapshot,
  );
  const view = views["admin-monthly"];
  const { month, report, run, detail, refreshing, refreshSecs, refreshStartedAt, refreshProgress } = view;

  // 已等待时间每秒本地走一次。服务端回调是「判完一片」才来一次，间隔可能几十秒，
  // 光靠它刷新会让人以为卡死（之前就一直停在 0:00）。
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!refreshing) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [refreshing]);
  const waitedSecs = refreshStartedAt ? Math.max(0, Math.round((Date.now() - refreshStartedAt) / 1000)) : refreshSecs;
  const setMonth = (m: string) => attributionView.patch("admin-monthly", { month: m });
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  /** 默认读该月最新快照（秒开）。 */
  const load = React.useCallback(async (m: string) => {
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    setLoading(true);
    attributionView.patch("admin-monthly", { detail: null });
    try {
      const r = await snapshotApi.report(m);
      attributionView.patch("admin-monthly", { report: r.summary, run: r.run, loadedAt: Date.now() });
      if (!r.run) toast.info(`${m} 还没有归因快照，点「重新计算」生成一次（之后每晚会自动刷新）`);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  /** 按当下的飞书登记数据重跑该月全站点全人员归因，生成一条新快照。 */
  const refresh = async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    attributionView.patch("admin-monthly", { refreshing: true, refreshStartedAt: Date.now(), refreshSecs: 0, refreshProgress: null });
    try {
      await snapshotApi.refreshAsync(month, "MANUAL", (s, progress) =>
        attributionView.patch("admin-monthly", { refreshSecs: s, refreshProgress: progress ?? null }),
      );
      toast.success(`${month} 归因快照已更新`);
      await load(month);
    } catch (e) {
      toast.error(`重新计算失败：${(e as Error).message}`);
    } finally {
      attributionView.patch("admin-monthly", { refreshing: false, refreshProgress: null });
      // 不管前面成没成功都再读一次快照：收尾请求可能被网关掐断，但服务端已经把结果写完了，
      // 这时候只是前端拿不到返回值，不该让用户对着空页面。
      await load(month);
    }
  };

  // 首次进入且还没查过时才自动加载
  const bootRef = React.useRef(false);
  React.useEffect(() => {
    if (bootRef.current || view.report) return;
    bootRef.current = true;
    load(view.month);
  }, [load, view.month, view.report]);

  /** 下钻：直接查快照明细表，不重算。 */
  const drill = async (f: DrillFilter) => {
    const title = f.bucket ? (f.bucket === "PRODUCT_CARD" ? "商品卡明细" : f.bucket === "OTHER" ? "其他类型明细" : "无建联明细") : `${f.staff} 明细`;
    attributionView.patch("admin-monthly", { detail: { rows: [], title } });
    setDetailLoading(true);
    try {
      const r = await snapshotApi.detail({ run_id: run?.id, month, detail_for: f });
      attributionView.patch("admin-monthly", { detail: { rows: r.detail_rows ?? [], title } });
    } catch (e) {
      toast.error(`加载明细失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const exportVidSummary = async () => {
    setBusy("export");
    try {
      // 直接边下边转成表格行，不先攒一份对象数组——25 万行在浏览器里存两份，后半程必卡。
      const aoa: (string | number)[][] = [VID_SUMMARY_HEADER];
      const n = await exportApi.vidSummaryStream(month, (page, got) => {
        for (const r of page) {
          aoa.push([
            r.country, r.month, r.vid, r.account_name,
            r.staff, r.role, r.bucket, r.match_type,
            r.product_id, r.sku,
            r.gmv, r.cost, r.orders, r.roi ?? "", r.pv, r.clicks, r.ctr ?? "", r.cvr ?? "",
          ]);
        }
        toast.loading(`正在下载数据…已取 ${got.toLocaleString()} 行`, { id: "vid-export" });
      });
      if (!n) { toast.dismiss("vid-export"); toast.warning("没有可导出的数据"); return; }

      toast.loading(`正在生成 Excel（${n.toLocaleString()} 行），大文件需要十几秒…`, { id: "vid-export" });
      // 让 toast 先渲染出来，再进同步的表格生成——否则用户看到的是「卡住」
      await new Promise((res) => setTimeout(res, 50));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "VID汇总");
      XLSX.writeFile(wb, `VID汇总-${month}.xlsx`);
      toast.dismiss("vid-export");
      toast.success(`导出完成：${n.toLocaleString()} 行`);
    } catch (e) {
      toast.dismiss("vid-export");
      toast.error(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doSync = async (kind: "creators" | "targets" | "handovers" | "progress") => {
    setBusy(kind);
    try {
      if (kind === "creators") {
        // 分片跑：每跑完一批 sheet 更新一次提示，避免按钮转两分钟看不出死活
        const r = await syncCreators(({ processed, remaining, round }) => {
          if (remaining.length) {
            toast.info(`同步达人登记：第 ${round} 批完成（已处理 ${processed.length} 个表，还剩 ${remaining.length} 个）`);
          }
        });
        toast.success(
          `达人登记同步完成：登记 ${r.registry_rows} 行（含 VID ${r.registry_vid_rows ?? "?"} 行）· 归属 ${r.ownership_keys} 键 · 待审查 ${r.reviews_open}`,
        );
        if (r.missing_sheets.length) toast.warning(`缺少 sheet：${r.missing_sheets.join("、")}`);
        // 飞书把 VID 列当数字返回时，19 位 VID 超出 JS 2^53 精度会被静默改写成末尾补 0 的错值，
        // 正则照样通过但永远匹配不上——这类单元格已被丢弃，必须让用户去改列格式。
        if (r.vid_precision_lost) {
          toast.error(
            `有 ${r.vid_precision_lost} 个 VID 单元格被飞书当成数字返回、超出精度已被改写成错值（已丢弃不入库）。请把飞书建联表 P 列 / 授权记录 Q 列 / 剪辑表 G 列设为「文本」格式后重新同步，否则这些 VID 永远归因不上。`,
            { duration: 15000 },
          );
        }
        if (r.follower_rows) {
          toast.info(`顺带读到 ${r.follower_rows} 行达人粉丝量（已入库，前台暂不展示）`);
        }
        if (r.cjk_sites?.length) {
          const sample = r.cjk_sites.slice(0, 6).map((c) => `${c.site}(${c.rows})`).join("、");
          toast.error(
            `建联/剪辑表里有汉字站点写法：${sample}。站点统一用英文简写（PH / TH / VN / MX-AR / US…），含汉字的行永远匹配不上，请到飞书改正后重新同步。`,
            { duration: 15000 },
          );
        }
        if (!r.registry_vid_rows) {
          toast.warning("本次同步没有读到任何有效 VID：VID 强匹配这一层会完全失效，只能靠昵称路径归因。");
        }
      } else if (kind === "targets") {
        const r = await feishuAction<{ upserted: number; skipped: string[] }>("sync-targets");
        toast.success(`目标同步完成：${r.upserted} 条`);
        if (r.skipped?.length) toast.warning(`跳过：${r.skipped.join("；")}`);
      } else if (kind === "handovers") {
        const r = await feishuAction<{ synced: number; skipped: string[] }>("sync-handovers");
        toast.success(`站点交接同步完成：${r.synced} 条`);
        if (r.skipped?.length) toast.warning(`跳过：${r.skipped.join("；")}`);
      } else {
        const r = await feishuAction<{ appended: number }>("write-progress", { month });
        toast.success(`已回写飞书「归因进度」：${r.appended} 行快照`);
      }
    } catch (e) {
      toast.error(`操作失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">数据准备</CardTitle>
          <p className="text-xs text-muted-foreground">
            这三个按钮只更新基础数据。归因结果在每次「生成报表」时按当下的登记数据现算，同步完刷新即可，不需要重传广告表。
            三个同步每晚北京 23:00 会自动各跑一次（早于 23:30 的归因快照），这里的按钮只是「现在就要最新数据」时用。
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="outline" onClick={() => doSync("creators")} disabled={!!busy}>
              <Users className={`h-4 w-4 mr-1.5 ${busy === "creators" ? "animate-pulse" : ""}`} />同步达人登记
            </Button>
            <SyncHelp kind="creators" />
          </div>
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="outline" onClick={() => doSync("targets")} disabled={!!busy}>
              <TargetIcon className="h-4 w-4 mr-1.5" />同步 GMV 目标
            </Button>
            <SyncHelp kind="targets" />
          </div>
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="outline" onClick={() => doSync("handovers")} disabled={!!busy}>
              <ArrowLeftRight className="h-4 w-4 mr-1.5" />同步站点交接
            </Button>
            <SyncHelp kind="handovers" />
          </div>
          <div className="flex flex-col gap-1 ml-auto">
            <span className="text-xs text-muted-foreground">月份</span>
            <div className="flex items-center gap-2">
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" />
              <Button size="sm" onClick={() => load(month)} disabled={loading || refreshing}>
                <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />读取快照
              </Button>
              <Button size="sm" variant="outline" onClick={refresh} disabled={loading || refreshing} title="按当下的飞书登记数据重跑该月全站点全人员归因，生成一条新快照">
                <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />重新计算
              </Button>
              <div className="flex items-center gap-0.5">
                <Button size="sm" variant="outline" onClick={() => doSync("progress")} disabled={!!busy || !report}>
                  <Upload className="h-4 w-4 mr-1.5" />回写飞书进度
                </Button>
                <SyncHelp kind="progress" />
              </div>
              <div className="flex items-center gap-0.5">
                <Button size="sm" variant="outline" onClick={exportVidSummary} disabled={!!busy || !report}>
                  <Download className={`h-4 w-4 mr-1.5 ${busy === "export" ? "animate-spin" : ""}`} />导出唯一VID汇总
                </Button>
                <SyncHelp kind="export" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1">
        数据来源：归因结果快照（每晚 23:30 自动刷新全部近月；也可随时手动重新计算）
        {run ? (
          <>
            {" · "}快照时间：{run.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}
            （{run.source === "CRON" ? "每晚自动" : run.source === "UPLOAD" ? "上传后" : "手动"}
            {run.triggered_by ? ` · ${run.triggered_by}` : ""}）
            {" · "}{run.upload_count} 个批次 / {run.raw_rows.toLocaleString()} 原始行 / {run.agg_rows.toLocaleString()} 归并组
          </>
        ) : (
          " · 该月还没有快照"
        )}
        <RunHistory month={month} />
      </div>

      <DataPrepPanel month={month} />

      <IdentityPreviewPanel />

      {refreshing ? (
        <div className="text-sm text-muted-foreground text-center py-16 space-y-1">
          <div>
            正在重新计算该月全站点归因，请稍候…（已等待 {Math.floor(waitedSecs / 60)}:{String(waitedSecs % 60).padStart(2, "0")}）
          </div>
          {refreshProgress ? (
            <div className="text-xs space-y-1">
              <div>
                {refreshProgress.country
                  ? `已判完 ${refreshProgress.country} 第 ${refreshProgress.chunks} 片`
                  : "正在切分判定分片"}
                {refreshProgress.total
                  ? ` · 剩 ${refreshProgress.remaining.toLocaleString()} / ${refreshProgress.total.toLocaleString()} 个待判定`
                  : ""}
              </div>
              {refreshProgress.total ? (
                <div className="mx-auto w-64 h-1.5 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${Math.round(((refreshProgress.total - refreshProgress.remaining) / refreshProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="text-xs">判定按站点分片执行，判完一片就存库；中途离开本页也不会白跑。</div>
        </div>
      ) : loading && !report ? (
        <div className="text-sm text-muted-foreground text-center py-16">读取归因快照…</div>
      ) : report ? (
        <>
          <ProgressBoard report={report} mode="admin" onDrill={drill} />
          {detail ? <DetailTable rows={detail.rows} loading={detailLoading} title={detail.title} /> : null}
          {report.by_type?.length ? <TypeMixPanel rows={report.by_type} /> : null}
          <SiteMismatchTable month={month} />
          <DiagnosePanel month={month} />
          <ReconcilePanel month={month} />
        </>
      ) : (
        <>
          <div className="text-sm text-muted-foreground text-center py-8">选择月份后点击「读取快照」；该月没有快照时点「重新计算」生成一次</div>
          {/* 报表还没生成、或者生成出来一个人都没有时，自查/对账面板是排查入口，所以这里也要显示 */}
          <DiagnosePanel month={month} />
          <ReconcilePanel month={month} />
        </>
      )}
    </div>
  );
}

function UploadResultView() {
  const [result, setResult] = React.useState<{ viewing: Viewing; summary: AttributionReport } | null>(null);
  const [detail, setDetail] = React.useState<{ rows: DetailRow[]; title: string } | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [tab, setTab] = React.useState("monthly");

  const onResult = React.useCallback((r: { viewing: Viewing; summary: AttributionReport } | null) => {
    setResult(r);
    setDetail(null);
    if (r) setTab("result");
  }, []);

  const drill = async (f: DrillFilter) => {
    if (!result) return;
    const title = f.bucket ? (f.bucket === "PRODUCT_CARD" ? "商品卡明细" : f.bucket === "OTHER" ? "其他类型明细" : "无建联明细") : `${f.staff} 明细`;
    setDetail({ rows: [], title });
    setDetailLoading(true);
    try {
      const v = result.viewing;
      const r = v.kind === "upload"
        ? await uploadApi.get({ upload_id: v.id, detail_for: f })
        : await uploadApi.get({ month: v.month, merged: true, detail_for: f });
      setDetail({ rows: r.detail_rows ?? [], title });
    } catch (e) {
      toast.error(`加载明细失败：${(e as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="monthly">月度进度</TabsTrigger>
        <TabsTrigger value="upload">Excel 上传</TabsTrigger>
        <TabsTrigger value="review">审查与回写</TabsTrigger>
        <TabsTrigger value="result">归因结果</TabsTrigger>
      </TabsList>
      <TabsContent value="monthly" className="mt-4">
        <MonthlyView />
      </TabsContent>
      <TabsContent value="upload" className="mt-4">
        <UploadView onResult={onResult} />
      </TabsContent>
      <TabsContent value="review" className="mt-4">
        <ReviewPanel />
      </TabsContent>
      <TabsContent value="result" className="mt-4 space-y-4">
        {result ? (
          <>
            <div className="text-sm font-medium">
              归因结果：{result.viewing.kind === "upload" ? result.viewing.label : `${result.viewing.month} 全站点合并`}
            </div>
            <ProgressBoard report={result.summary} mode="admin" onDrill={drill} />
            {detail ? <DetailTable rows={detail.rows} loading={detailLoading} title={detail.title} /> : null}
          </>
        ) : (
          <div className="text-sm text-muted-foreground text-center py-16">
            在「Excel 上传」中上传文件或点击历史记录查看，结果会显示在这里
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function GmvAttributionAdminPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">GMV 归因 · 管理</h2>
        <p className="text-sm text-muted-foreground mt-1">
          全量口径（含离职）：商品卡 / 剪辑VID / BD-VID / BD-昵称 / BD-模糊 / 无建联 · 一行数据只归一个人
        </p>
      </div>
      <UploadResultView />
    </div>
  );
}

