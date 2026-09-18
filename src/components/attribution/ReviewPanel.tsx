// 审查面板：把每条冲突拆成「冲突在哪个维度 / 各候选人凭什么 / 各自什么时候在哪个站点登记的」，
// 人才判得动。判定结果立即写数据库，并尽力同步回飞书「归因审查」表。
//
// 设计要点（都是被实际用坏过才改的）：
//   · 冲突维度必须写在明面上 —— 同样是「两个人抢一个达人」，VID 双登记和昵称/用户名冲突
//     要看的证据完全不同，混在一起人只能去读 JSON；
//   · 每个候选人都要带**站点 + 日期**，否则「归谁」这个问题在页面上没有可判的依据；
//   · 判定下拉必须有内容，且冲突双方 + 忽略排最前 —— 九成的判定就是在这三项里选一个；
//   · 列表分页（每页 10 条）：审查项常年几百上千条，一次铺完页面既滚不动也判不完。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RotateCw, Upload, Download, BookUser, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { type ReviewRec, REVIEW_TYPE_LABELS, feishuAction } from "@/lib/attributionApi";
import { ReviewExcelPanel } from "./ReviewExcelPanel";

const PAGE_SIZE = 10;

/** 一个候选归属：谁、凭什么、哪个站点、什么时候。表格里一行。 */
type ConflictRow = {
  staff: string;
  basis: string;
  country: string;
  firstDate: string;
  lastDate: string;
  note: string;
  isDefault: boolean;
};

type VidDualDetail = {
  candidates: Array<{ staff: string; role: string; registerDate: string | null; country: string }>;
  chosen: string;
  overridden: boolean;
};
type AliasVoteDetail =
  | { kind: "multi_bd"; votes: Array<{ bd: string; vids: string[]; count: number }> }
  | { kind: "vs_registry"; vidEvidence: { bd: string; vids: string[] }; registryOwner: string }
  | { kind: "vs_existing_alias"; newVote: { bd: string; vids: string[] }; existingBd: string };
type GrabDetail = {
  keyType: "NICKNAME" | "HANDLE";
  owner: string;
  ownerLastDate: string | null;
  grabs: Array<{ bd: string; date: string | null; sheet: string; row: number | null }>;
};
type KeyTypeDetail = {
  country?: string;
  matchKey?: string;
  nicknameOwner?: string;
  nicknameFirstDate?: string | null;
  nicknameLastDate?: string | null;
  handleOwner?: string;
  handleFirstDate?: string | null;
  handleLastDate?: string | null;
};
type HandoverDetail = { country: string; transferDate?: string; handoverDate?: string; date?: string; count: number; samples: string[] };

const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

/** review_key 里带的站点：ALIAS:<站点>\u001f<名> / KEYTYPE:<站点>\u001f<名> / GRAB:<类型>:<站点>\u001f<名>。 */
function countryOf(r: ReviewRec): string {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  if (typeof d.country === "string" && d.country) return d.country;
  const withSite = (raw: string) => {
    const at = raw.indexOf("\u001f");
    return at < 0 ? "" : raw.slice(0, at);
  };
  if (r.review_key.startsWith("ALIAS:")) return withSite(r.review_key.slice("ALIAS:".length));
  if (r.review_key.startsWith("KEYTYPE:")) return withSite(r.review_key.slice("KEYTYPE:".length));
  if (r.review_key.startsWith("GRAB:")) return withSite(r.review_key.split(":").slice(2).join(":"));
  return "";
}

/** 这条冲突到底冲在哪个维度上 —— 卡片最顶上那句话。 */
function dimensionOf(r: ReviewRec): string {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  switch (r.review_type) {
    case "VID_DUAL_SOURCE":
      return `冲突维度：VID —— 同一条素材 ${r.subject} 被多个同事登记`;
    case "KEYTYPE_CONFLICT":
      return `冲突维度：昵称 ↔ 用户名 —— 同一个字符串「${r.subject}」既是一个人的昵称、又是另一个人的用户名，两边归属不同`;
    case "PROTECTION_GRAB":
      return `冲突维度：${(d as GrabDetail).keyType === "HANDLE" ? "用户名" : "昵称"} —— 保护期（90 自然天）内有别的同事又登记了这个达人`;
    case "ALIAS_VOTE_CONFLICT":
      return `冲突维度：达人昵称 —— 「${r.subject}」的 VID 证据与现有归属对不上`;
    case "HANDOVER_BOUNDARY":
      return "提示类：发布时间由 VID 反推、又正好落在交接日附近，可能误归（判不判都不影响自动归因结果）";
    default:
      return "";
  }
}

/** 把各种 detail 拍平成统一的候选表。判定下拉的前几项也从这里取。 */
function conflictRows(r: ReviewRec): ConflictRow[] {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const country = countryOf(r);
  const row = (p: Partial<ConflictRow> & { staff: string; basis: string }): ConflictRow => ({
    country,
    firstDate: "",
    lastDate: "",
    note: "",
    isDefault: false,
    ...p,
  });

  if (r.review_type === "VID_DUAL_SOURCE") {
    const dd = d as unknown as VidDualDetail;
    return (dd.candidates ?? []).map((c) =>
      row({
        staff: c.staff,
        basis: `VID 登记（${c.role === "EDITOR" ? "剪辑" : "BD"}）`,
        country: c.country || country,
        lastDate: c.registerDate ?? "",
        isDefault: c.staff === dd.chosen,
      }),
    );
  }

  if (r.review_type === "KEYTYPE_CONFLICT") {
    const dd = d as KeyTypeDetail;
    const out: ConflictRow[] = [];
    if (dd.nicknameOwner) {
      out.push(row({
        staff: dd.nicknameOwner,
        basis: "按昵称匹配到的归属",
        firstDate: dd.nicknameFirstDate ?? "",
        lastDate: dd.nicknameLastDate ?? "",
        isDefault: true, // 匹配时昵称优先，所以昵称侧是系统默认
      }));
    }
    if (dd.handleOwner) {
      out.push(row({
        staff: dd.handleOwner,
        basis: "按用户名匹配到的归属",
        firstDate: dd.handleFirstDate ?? "",
        lastDate: dd.handleLastDate ?? "",
      }));
    }
    return out;
  }

  if (r.review_type === "PROTECTION_GRAB") {
    const dd = d as unknown as GrabDetail;
    const out: ConflictRow[] = [
      row({
        staff: dd.owner,
        basis: "当前归属（最早建联）",
        lastDate: dd.ownerLastDate ?? "",
        isDefault: true,
      }),
    ];
    for (const g of dd.grabs ?? []) {
      out.push(row({
        staff: g.bd,
        basis: "保护期内又登记（抢注）",
        lastDate: g.date ?? "",
        note: `${g.sheet}${g.row ? ` 第${g.row}行` : ""}`,
      }));
    }
    return out;
  }

  if (r.review_type === "ALIAS_VOTE_CONFLICT") {
    const dd = d as unknown as AliasVoteDetail;
    if (dd.kind === "multi_bd") {
      return dd.votes.map((v) => row({
        staff: v.bd,
        basis: `VID 证据 ×${v.count}`,
        note: v.vids.slice(0, 3).join("、"),
      }));
    }
    if (dd.kind === "vs_registry") {
      return [
        row({ staff: dd.vidEvidence.bd, basis: "本次 VID 证据", note: dd.vidEvidence.vids.slice(0, 3).join("、") }),
        row({ staff: dd.registryOwner, basis: "建联表归属", isDefault: true }),
      ];
    }
    return [
      row({ staff: dd.newVote.bd, basis: "本次新证据", note: dd.newVote.vids.slice(0, 3).join("、") }),
      row({ staff: dd.existingBd, basis: "已有别名", isDefault: true }),
    ];
  }

  return [];
}

function ConflictTable({ r }: { r: ReviewRec }) {
  const rows = conflictRows(r);
  if (r.review_type === "HANDOVER_BOUNDARY") {
    const dd = (r.detail ?? {}) as unknown as HandoverDetail;
    return (
      <div className="text-xs space-y-0.5">
        <div>站点 {dash(dd.country)} · 实际转移日 {dash(dd.transferDate ?? dd.date)} · 涉及 {dd.count} 行</div>
        <div className="text-muted-foreground">示例：{(dd.samples ?? []).slice(0, 8).join("、") || "—"}</div>
      </div>
    );
  }
  if (!rows.length) {
    return <pre className="text-xs whitespace-pre-wrap text-muted-foreground">{JSON.stringify(r.detail, null, 2).slice(0, 600)}</pre>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr className="text-muted-foreground border-b">
            <th className="text-left font-normal py-1 pr-3">候选归属</th>
            <th className="text-left font-normal pr-3">依据</th>
            <th className="text-left font-normal pr-3">站点</th>
            <th className="text-left font-normal pr-3">首次登记</th>
            <th className="text-left font-normal pr-3">最近登记</th>
            <th className="text-left font-normal">来源 / 证据</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={`${c.staff}|${c.basis}|${i}`} className="border-b last:border-0">
              <td className="py-1 pr-3 font-medium whitespace-nowrap">
                {c.staff}
                {c.isDefault ? <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">系统默认</Badge> : null}
              </td>
              <td className="pr-3 whitespace-nowrap">{c.basis}</td>
              <td className="pr-3 whitespace-nowrap">{dash(c.country)}</td>
              <td className="pr-3 tabular-nums whitespace-nowrap">{dash(c.firstDate)}</td>
              <td className="pr-3 tabular-nums whitespace-nowrap">{dash(c.lastDate)}</td>
              <td className="text-muted-foreground">{dash(c.note)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewCard({ r, staff, onSubmitted }: { r: ReviewRec; staff: string[]; onSubmitted: () => void }) {
  const rows = React.useMemo(() => conflictRows(r), [r]);
  const [bd, setBd] = React.useState(r.manual_bd ?? "");
  const [note, setNote] = React.useState(r.manual_note ?? "");
  const [busy, setBusy] = React.useState(false);
  // 交接边界是提示类：有默认结论、判不判都不改数字，所以不给判定下拉，只给「标记已复核」
  const noPicker = r.review_type === "HANDOVER_BOUNDARY";

  /** 冲突双方 + 忽略排最前（九成判定就在这三项里），其余同事按人员表顺序排后面 */
  const { top, rest } = React.useMemo(() => {
    const seen = new Set<string>();
    const top: string[] = [];
    for (const c of rows) {
      if (c.staff && !seen.has(c.staff)) {
        seen.add(c.staff);
        top.push(c.staff);
      }
    }
    const rest = staff.filter((n) => !seen.has(n));
    return { top, rest };
  }, [rows, staff]);

  const submit = async (value: string) => {
    setBusy(true);
    try {
      const r2 = await feishuAction<{ warning?: string; mirrored: boolean; mirror_warning?: string }>("submit-judgment", {
        review_key: r.review_key,
        manual_bd: value,
        manual_note: note,
      });
      toast.success(`已提交：${r.subject} → ${value}`);
      if (r2.warning) toast.warning(r2.warning);
      if (r2.mirror_warning) toast.warning(r2.mirror_warning);
      onSubmitted();
    } catch (e) {
      toast.error(`提交判定失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary">{REVIEW_TYPE_LABELS[r.review_type] ?? r.review_type}</Badge>
            <span className="text-sm font-medium">{r.subject}</span>
            {countryOf(r) ? <Badge variant="outline">{countryOf(r)}</Badge> : null}
            <Badge variant={r.status === "OPEN" ? "destructive" : "outline"}>{r.status === "OPEN" ? "待处理" : "已裁决"}</Badge>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">最近发现 {(r.last_seen_at ?? "").slice(0, 10)}</span>
        </div>

        <div className="text-xs text-muted-foreground">{dimensionOf(r)}</div>
        <ConflictTable r={r} />

        <div className="text-xs text-muted-foreground">
          系统默认：{r.default_resolution || "—"}
          {r.manual_bd ? ` · 当前判定：${r.manual_bd}${r.manual_note ? `（${r.manual_note}）` : ""}` : ""}
        </div>

        <div className="flex flex-wrap items-end gap-2 pt-1 border-t">
          {!noPicker ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">判定归属</span>
              <select
                value={bd}
                onChange={(e) => setBd(e.target.value)}
                className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                <option value="">请选择…</option>
                {top.map((n) => <option key={`t-${n}`} value={n}>{n}（本条冲突方）</option>)}
                <option value="忽略">忽略（不归任何人）</option>
                {rest.length ? (
                  <optgroup label="其他同事">
                    {rest.map((n) => <option key={`r-${n}`} value={n}>{n}</option>)}
                  </optgroup>
                ) : null}
              </select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">备注</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-8 w-56" placeholder="可选" />
          </div>
          {noPicker ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => submit("忽略")}>
              <Check className="h-4 w-4 mr-1.5" />标记已复核
            </Button>
          ) : (
            <Button size="sm" disabled={busy || !bd.trim()} onClick={() => submit(bd.trim())}>
              <Check className="h-4 w-4 mr-1.5" />提交判定
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ReviewPanel({ staffNames = [] }: { staffNames?: string[] }) {
  const [reviews, setReviews] = React.useState<ReviewRec[]>([]);
  const [staff, setStaff] = React.useState<string[]>(staffNames);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);
  const [typeFilter, setTypeFilter] = React.useState("");
  const [page, setPage] = React.useState(1);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await feishuAction<{ reviews: ReviewRec[] }>("list-reviews");
      setReviews(r.reviews ?? []);
    } catch (e) {
      toast.error(`加载审查项失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  // 判定下拉的人员名单从人员表取（含离职：历史冲突可能要判给已离职的同事）。
  // 拿不到就退回调用方传进来的名单，至少冲突双方还在。
  React.useEffect(() => {
    let alive = true;
    feishuAction<{ staff: Array<{ name: string }> }>("list-staff")
      .then((r) => {
        if (alive && r.staff?.length) setStaff(r.staff.map((s) => s.name));
      })
      .catch(() => { /* 下拉里仍有冲突双方与忽略，不打断判定 */ });
    return () => { alive = false; };
  }, []);

  const run = async (action: string, label: string) => {
    setBusy(action);
    try {
      const r = await feishuAction<Record<string, unknown>>(action);
      const warnings = (r.warnings as string[] | undefined) ?? [];
      toast.success(`${label}完成：${JSON.stringify({ ...r, warnings: undefined })}`);
      for (const w of warnings) toast.warning(w);
      await load();
    } catch (e) {
      toast.error(`${label}失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const open = reviews.filter((r) => r.status === "OPEN");
  const types = React.useMemo(
    () => Array.from(new Set(reviews.map((r) => r.review_type))).sort(),
    [reviews],
  );
  const visible = React.useMemo(() => {
    const base = showResolved ? reviews : open;
    return typeFilter ? base.filter((r) => r.review_type === typeFilter) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews, showResolved, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = visible.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  // 换筛选条件后停在第 7 页会看到空白，统一回第一页
  React.useEffect(() => { setPage(1); }, [showResolved, typeFilter]);

  return (
    <div className="space-y-4">
      {/* 批量通道：几百条审查项逐条点不现实，导出 Excel 线下填完再传回来 */}
      <ReviewExcelPanel reviews={visible} staffNames={staff} onApplied={load} />
      <Card>
        <CardHeader className="pb-3 space-y-2">
          <CardTitle className="text-base">
            归因审查{" "}
            <span className="text-xs font-normal text-muted-foreground ml-1">
              待处理 {open.length} / 共 {reviews.length}
              {typeFilter || showResolved ? ` · 当前筛选 ${visible.length}` : ""}
            </span>
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? "只看待处理" : "查看全部（含已裁决）"}
            </Button>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">全部类型</option>
              {types.map((t) => (
                <option key={t} value={t}>{REVIEW_TYPE_LABELS[t] ?? t}</option>
              ))}
            </select>
            <Button size="sm" onClick={() => run("write-reviews", "回写审查表")} disabled={!!busy}>
              <Upload className="h-4 w-4 mr-1.5" />回写新审查项到飞书
            </Button>
            <Button size="sm" onClick={() => run("read-judgments", "读回人工判定")} disabled={!!busy}>
              <Download className="h-4 w-4 mr-1.5" />读回飞书表里的判定
            </Button>
            <Button size="sm" variant="outline" onClick={() => run("write-ownership", "更新达人归因表")} disabled={!!busy}>
              <BookUser className="h-4 w-4 mr-1.5" />更新飞书「达人归因表」
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            每条冲突都列出了「候选归属 / 依据 / 站点 / 登记日期」，据此选一个归属并提交即可，判定立即写入数据库并尽力同步到飞书「归因审查」表。
            也可以继续用飞书表 J/K 列人工填写后点「读回飞书表里的判定」。人工判定优先级最高且不会被自动覆盖。
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <div className="text-sm text-muted-foreground text-center py-16">加载中…</div>
          ) : pageRows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-16">
              {showResolved || typeFilter ? "当前筛选下没有审查项" : "没有待处理的审查项"}
            </div>
          ) : (
            <>
              {pageRows.map((r) => (
                <ReviewCard key={r.review_key} r={r} staff={staff} onSubmitted={load} />
              ))}
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  第 {(curPage - 1) * PAGE_SIZE + 1}–{Math.min(curPage * PAGE_SIZE, visible.length)} 条 / 共 {visible.length} 条
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>
                    <ChevronLeft className="h-4 w-4" />上一页
                  </Button>
                  <span className="text-xs tabular-nums">{curPage} / {pageCount}</span>
                  <Button size="sm" variant="outline" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>
                    下一页<ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
