// 审查项 Excel 往返：导出 → 线下填「归因同事 + 原因」→ 传回来批量落库。
//
// 【人工判定 vs 人工覆盖】两条路，填表时用「判定类型」列区分，落库落到不同的表：
//   · 判定(JUDGE)        写 attribution_review + 昵称类的 creator_alias(MANUAL)，
//                        仍在归因瀑布的原位置生效，后续规则变化可能把它盖掉 —— 适合「这次冲突归谁」
//   · VID覆盖(OVERRIDE_VID)     写 attribution_manual_rules，**优先级最高**、永久有效可停用 —— 适合「这条素材就是他的，别再判了」
//   · 达人覆盖(OVERRIDE_CREATOR) 写 attribution_manual_decisions，从生效日起给这个达人建立一个归属阶段
//   · 忽略(IGNORE)       只把审查项标成已处理，不改任何归属
//
// 【下拉的现实】SheetJS 社区版不支持写 Excel 数据验证（下拉），所以模板里放不了原生下拉。
// 折中：第二个 sheet「可选值」列出全部合法取值，导入时**严格校验 + 整批拦截**，
// 填错不会被静默吞掉。要原生下拉的话，在 Excel 里对这两列做一次「数据验证 → 序列 → 引用可选值列」即可，
// 模板重复导出也不影响你自己设的验证。
import * as React from "react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, Upload, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { type BulkJudgmentRow, type ReviewRec, REVIEW_TYPE_LABELS, bulkJudgment } from "@/lib/attributionApi";

/** 填表用的判定类型：中文写法 → 后端枚举。中英文、带不带括号都认，减少填错。 */
const DECISION_ALIASES: Record<string, string> = {
  "判定": "JUDGE",
  "人工判定": "JUDGE",
  "judge": "JUDGE",
  "vid覆盖": "OVERRIDE_VID",
  "vid级覆盖": "OVERRIDE_VID",
  "人工覆盖-vid": "OVERRIDE_VID",
  "override_vid": "OVERRIDE_VID",
  "达人覆盖": "OVERRIDE_CREATOR",
  "达人级覆盖": "OVERRIDE_CREATOR",
  "人工覆盖-达人": "OVERRIDE_CREATOR",
  "override_creator": "OVERRIDE_CREATOR",
  "忽略": "IGNORE",
  "不处理": "IGNORE",
  "ignore": "IGNORE",
};

const DECISION_OPTIONS = ["判定", "VID覆盖", "达人覆盖", "忽略"];

/** 原因枚举：既是下拉可选值，也是以后复核这条人工决定时的唯一线索。允许自由填写。 */
const REASON_OPTIONS = [
  "登记有误",
  "达人确由此同事开发",
  "保护期内抢注无效",
  "交接后归新BD",
  "同一达人多个账号",
  "素材由剪辑制作",
  "公司自营号/不算任何人",
  "其他（见备注）",
];

const HEADERS = [
  "审查ID",
  "类型",
  "对象",
  "候选人",
  "默认结论",
  "当前判定",
  "判定类型",
  "归因同事",
  "原因",
  "备注",
  "VID（VID覆盖必填）",
  "站点（达人覆盖必填）",
  "达人昵称（达人覆盖必填）",
  "生效起始日（达人覆盖可选）",
];

function candidatesText(r: ReviewRec): string {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const pick = (arr: unknown, f: (x: Record<string, unknown>) => string) =>
    Array.isArray(arr) ? (arr as Array<Record<string, unknown>>).map(f).filter(Boolean).join(" / ") : "";
  if (Array.isArray(d.candidates)) return pick(d.candidates, (c) => `${c.staff}(${c.role})`);
  if (Array.isArray(d.votes)) return pick(d.votes, (v) => `${v.bd}×${v.count}`);
  if (Array.isArray(d.grabs)) return [String(d.owner ?? ""), ...(d.grabs as Array<{ bd?: string }>).map((g) => g.bd ?? "")].filter(Boolean).join(" / ");
  if (d.nicknameOwner || d.handleOwner) return [d.nicknameOwner, d.handleOwner].filter(Boolean).join(" / ");
  return "";
}

/** VID 类审查项的 review_key 形如 VID_DUAL:<vid>，导出时把 VID 先填好，省得人工去抄 19 位数字。 */
function vidOf(r: ReviewRec): string {
  if (r.review_key.startsWith("VID_DUAL:")) return r.review_key.slice("VID_DUAL:".length);
  return /^\d{15,20}$/.test(r.subject) ? r.subject : "";
}

/** 昵称类审查项的 review_key 里带站点（ALIAS:<站点>\u001f<归一化名> / GRAB:<类型>:<站点>\u001f<名>）。 */
function siteAndCreator(r: ReviewRec): { country: string; creatorKey: string } {
  const withSite = (raw: string) => {
    const at = raw.indexOf("\u001f");
    return at < 0 ? { country: "", creatorKey: raw } : { country: raw.slice(0, at), creatorKey: raw.slice(at + 1) };
  };
  if (r.review_key.startsWith("ALIAS:")) return withSite(r.review_key.slice("ALIAS:".length));
  if (r.review_key.startsWith("KEYTYPE:")) return withSite(r.review_key.slice("KEYTYPE:".length));
  if (r.review_key.startsWith("GRAB:")) {
    const rest = r.review_key.split(":").slice(2).join(":");
    return withSite(rest);
  }
  return { country: "", creatorKey: "" };
}

export function ReviewExcelPanel({ reviews, staffNames, onApplied }: {
  reviews: ReviewRec[];
  staffNames: string[];
  onApplied: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const exportXlsx = () => {
    if (!reviews.length) {
      toast.warning("当前列表没有审查项可导出");
      return;
    }
    const rows = reviews.map((r) => {
      const { country, creatorKey } = siteAndCreator(r);
      return [
        r.review_key,
        REVIEW_TYPE_LABELS[r.review_type] ?? r.review_type,
        r.subject,
        candidatesText(r),
        r.default_resolution ?? "",
        r.manual_bd ?? "",
        "", // 判定类型
        "", // 归因同事
        "", // 原因
        "", // 备注
        vidOf(r),
        country,
        creatorKey,
        "",
      ];
    });
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
    ws["!cols"] = [
      { wch: 34 }, { wch: 14 }, { wch: 22 }, { wch: 26 }, { wch: 34 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 21 }, { wch: 10 }, { wch: 20 }, { wch: 18 },
    ];

    // 第二个 sheet：可选值 + 填表说明（社区版 xlsx 写不了原生下拉，只能用它兜）
    const maxLen = Math.max(DECISION_OPTIONS.length, REASON_OPTIONS.length, staffNames.length);
    const optRows: string[][] = [["判定类型", "归因同事", "原因"]];
    for (let i = 0; i < maxLen; i++) {
      optRows.push([DECISION_OPTIONS[i] ?? "", staffNames[i] ?? "", REASON_OPTIONS[i] ?? ""]);
    }
    const guide = [
      [""],
      ["填表说明"],
      ["1. 只填「判定类型 / 归因同事 / 原因」三列，其余列不要改（审查ID 是回填的钥匙，改了就对不上）。"],
      ["2. 判定类型的含义："],
      ["   判定      = 普通人工判定，写进审查表，后续规则变化可能覆盖它。适合「这次冲突归谁」。"],
      ["   VID覆盖   = 最高优先级，按 VID 永久锁定归属，除非停用。适合「这条素材就是他的」。需填 VID 列。"],
      ["   达人覆盖  = 按达人锁定归属，从生效起始日起算。需填 站点 + 达人昵称；生效起始日留空表示从最早开始。"],
      ["   忽略      = 只把这条标成已处理，不改任何归属。"],
      ["3. 归因同事必须与人员表完全一致（见本页 B 列），写错会被整批拦下并列出行号。"],
      ["4. 原因必填，可以从 C 列选，也可以自己写。"],
      ["5. 想要原生下拉：选中「判定类型/归因同事」两列 → 数据 → 数据验证 → 序列 → 引用本页对应列。"],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet([...optRows, ...guide.map((g) => [g[0] ?? ""])]);
    ws2["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 24 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "审查项");
    XLSX.utils.book_append_sheet(wb, ws2, "可选值与说明");
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `归因审查_${stamp}_${rows.length}条.xlsx`);
    toast.success(`已导出 ${rows.length} 条审查项`);
  };

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets["审查项"] ?? wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("找不到「审查项」工作表");
      const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
      const head = (grid[0] ?? []).map((h) => String(h ?? "").trim());
      const col = (name: string) => head.findIndex((h) => h.startsWith(name));
      const iKey = col("审查ID");
      const iType = col("判定类型");
      const iStaff = col("归因同事");
      const iReason = col("原因");
      if (iKey < 0 || iType < 0 || iStaff < 0 || iReason < 0) {
        throw new Error("表头不对：需要「审查ID / 判定类型 / 归因同事 / 原因」四列，请用导出的模板填写");
      }
      const iNote = col("备注");
      const iVid = col("VID");
      const iCountry = col("站点");
      const iCreator = col("达人昵称");
      const iFrom = col("生效起始日");
      const cell = (r: unknown[], i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");

      const rows: BulkJudgmentRow[] = [];
      for (let i = 1; i < grid.length; i++) {
        const r = grid[i] ?? [];
        const typeRaw = cell(r, iType);
        if (!typeRaw) continue; // 没填判定类型 = 这行本次不处理
        const key = cell(r, iKey);
        if (!key) continue;
        rows.push({
          row_no: i + 1,
          review_key: key,
          decision_type: DECISION_ALIASES[typeRaw.toLowerCase().replace(/\s/g, "")] ?? typeRaw.toUpperCase(),
          staff_name: cell(r, iStaff),
          reason: cell(r, iReason),
          note: cell(r, iNote),
          vid: cell(r, iVid),
          country: cell(r, iCountry),
          creator_key: cell(r, iCreator),
          effective_from: cell(r, iFrom),
        });
      }
      if (!rows.length) throw new Error("没有填了「判定类型」的行，没什么可提交的");

      // 先干跑一遍：有错就整批不写，把行号原样报出来
      const check = await bulkJudgment(rows, true);
      if (check.errors?.length) {
        const lines = check.errors.slice(0, 8).map((e) => `第 ${e.row} 行：${e.message}`);
        toast.error(
          `${check.errors.length} 行填写有问题，本次没有写入任何数据：\n${lines.join("\n")}${check.errors.length > 8 ? "\n…" : ""}`,
          { duration: 20000 },
        );
        return;
      }
      const res = await bulkJudgment(rows, false);
      toast.success(
        `已落库 ${res.applied} 行：判定 ${res.judged ?? 0} · VID覆盖 ${res.override_vid ?? 0} · 达人覆盖 ${res.override_creator ?? 0} · 忽略 ${res.ignored ?? 0}`,
        { duration: 10000 },
      );
      for (const w of res.warnings ?? []) toast.warning(w, { duration: 12000 });
      onApplied();
    } catch (e) {
      toast.error(`导入失败：${(e as Error).message}`, { duration: 15000 });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" />审查项 Excel 批量处理
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          导出当前筛选出的审查项 → 线下填「判定类型 / 归因同事 / 原因」→ 传回来批量落库。
          <b>判定</b>写进审查表、后续规则变化可能覆盖；<b>VID覆盖 / 达人覆盖</b>写进人工覆盖表，优先级最高、只有停用才失效。
          上传时先整批校验，有一行填错就全部不写并列出行号。
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={exportXlsx} disabled={busy}>
          <Download className="h-4 w-4 mr-1.5" />导出审查 Excel（{reviews.length} 条）
        </Button>
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          <Upload className={`h-4 w-4 mr-1.5 ${busy ? "animate-pulse" : ""}`} />导入判定结果
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
          }}
        />
        <span className="text-xs text-muted-foreground">
          人工覆盖要等归因引擎接入覆盖表后才在报表里生效；人工判定立即生效。
        </span>
      </CardContent>
    </Card>
  );
}
