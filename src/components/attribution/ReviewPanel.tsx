// 审查面板：查看审查项结构化冲突详情，直接在网页端裁定（同时写数据库 + 尽力同步回飞书「归因审查」表）。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RotateCw, Upload, Download, BookUser, Check } from "lucide-react";
import { toast } from "sonner";
import { type ReviewRec, REVIEW_TYPE_LABELS, feishuAction } from "@/lib/attributionApi";

type Candidate = { value: string; label: string };

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
type HandoverDetail = { country: string; date: string; count: number; samples: string[] };

/** 每种审查类型的候选人（用于判定下拉建议）。 */
function candidateOptions(r: ReviewRec): Candidate[] {
  const d = r.detail as Record<string, unknown>;
  if (r.review_type === "VID_DUAL_SOURCE") {
    const dd = d as VidDualDetail;
    return (dd.candidates ?? []).map((c) => ({ value: c.staff, label: `${c.staff}（${c.role}）` }));
  }
  if (r.review_type === "ALIAS_VOTE_CONFLICT") {
    const dd = d as AliasVoteDetail;
    if (dd.kind === "multi_bd") return dd.votes.map((v) => ({ value: v.bd, label: `${v.bd}（VID证据×${v.count}）` }));
    if (dd.kind === "vs_registry") {
      return [
        { value: dd.vidEvidence.bd, label: `${dd.vidEvidence.bd}（本次 VID 证据）` },
        { value: dd.registryOwner, label: `${dd.registryOwner}（建联表归属）` },
      ];
    }
    return [
      { value: dd.newVote.bd, label: `${dd.newVote.bd}（本次新证据）` },
      { value: dd.existingBd, label: `${dd.existingBd}（已有别名）` },
    ];
  }
  if (r.review_type === "PROTECTION_GRAB") {
    const dd = d as GrabDetail;
    const seen = new Set<string>();
    const opts: Candidate[] = [];
    const add = (value: string, label: string) => { if (value && !seen.has(value)) { seen.add(value); opts.push({ value, label }); } };
    add(dd.owner, `${dd.owner}（当前归属 · 保护期内）`);
    for (const g of dd.grabs ?? []) add(g.bd, `${g.bd}（${g.date ?? "无日期"} 抢注登记）`);
    return opts;
  }
  return [];
}

function DetailBlock({ r }: { r: ReviewRec }) {
  const d = r.detail as Record<string, unknown>;
  if (r.review_type === "VID_DUAL_SOURCE") {
    const dd = d as VidDualDetail;
    return (
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">依据：VID 强匹配双登记 · VID = {r.subject}</div>
        <table className="text-xs w-full">
          <thead><tr className="text-muted-foreground"><th className="text-left font-normal py-0.5">候选人</th><th className="text-left font-normal">角色</th><th className="text-left font-normal">登记日期</th><th className="text-left font-normal">站点</th></tr></thead>
          <tbody>
            {(dd.candidates ?? []).map((c) => (
              <tr key={`${c.staff}|${c.role}`} className={c.staff === dd.chosen ? "font-medium" : ""}>
                <td className="py-0.5">{c.staff}{c.staff === dd.chosen ? <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">当前默认</Badge> : null}</td>
                <td>{c.role}</td>
                <td className="tabular-nums">{c.registerDate ?? "—"}</td>
                <td>{c.country || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (r.review_type === "ALIAS_VOTE_CONFLICT") {
    const dd = d as AliasVoteDetail;
    return (
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">依据：达人昵称 · 昵称 = {r.subject}</div>
        {dd.kind === "multi_bd" ? (
          <table className="text-xs w-full">
            <thead><tr className="text-muted-foreground"><th className="text-left font-normal py-0.5">BD</th><th className="text-left font-normal">VID 证据数</th><th className="text-left font-normal">示例 VID</th></tr></thead>
            <tbody>
              {dd.votes.map((v) => (
                <tr key={v.bd}><td className="py-0.5">{v.bd}</td><td className="tabular-nums">{v.count}</td><td className="text-muted-foreground">{v.vids.slice(0, 3).join("、")}</td></tr>
              ))}
            </tbody>
          </table>
        ) : dd.kind === "vs_registry" ? (
          <div className="text-xs space-y-0.5">
            <div>本次 VID 证据 → <b>{dd.vidEvidence.bd}</b>（{dd.vidEvidence.vids.slice(0, 3).join("、")}）</div>
            <div>建联表归属 → <b>{dd.registryOwner}</b></div>
          </div>
        ) : (
          <div className="text-xs space-y-0.5">
            <div>本次新证据 → <b>{dd.newVote.bd}</b>（{dd.newVote.vids.slice(0, 3).join("、")}）</div>
            <div>已有别名 → <b>{dd.existingBd}</b></div>
          </div>
        )}
      </div>
    );
  }
  if (r.review_type === "PROTECTION_GRAB") {
    const dd = d as GrabDetail;
    return (
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">依据：{dd.keyType === "NICKNAME" ? "达人昵称" : "达人用户名"} = {r.subject}</div>
        <table className="text-xs w-full">
          <thead><tr className="text-muted-foreground"><th className="text-left font-normal py-0.5">BD</th><th className="text-left font-normal">登记日期</th><th className="text-left font-normal">来源</th></tr></thead>
          <tbody>
            <tr className="font-medium"><td className="py-0.5">{dd.owner}<Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">当前归属</Badge></td><td className="tabular-nums">{dd.ownerLastDate ?? "—"}</td><td>保护期内最早/最后建联</td></tr>
            {(dd.grabs ?? []).map((g, i) => (
              <tr key={i}><td className="py-0.5">{g.bd}</td><td className="tabular-nums">{g.date ?? "—"}</td><td className="text-muted-foreground">{g.sheet}{g.row ? ` 第${g.row}行` : ""}（抢注登记）</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (r.review_type === "HANDOVER_BOUNDARY") {
    const dd = d as HandoverDetail;
    const m = r.subject.match(/交接（(.+?)→(.+?)）/);
    return (
      <div className="space-y-1 text-xs">
        <div className="text-muted-foreground">依据：站点交接边界 · {dd.country} {dd.date}{m ? ` · ${m[1]}→${m[2]}` : ""}</div>
        <div>{dd.count} 行发布时间由 VID 反推且落在交接日 ±5 天内，可能误归，仅供抽查（判定此项不会改变自动归因结果）</div>
        <div className="text-muted-foreground">示例：{(dd.samples ?? []).slice(0, 8).join("、")}</div>
      </div>
    );
  }
  return <pre className="text-xs whitespace-pre-wrap text-muted-foreground">{JSON.stringify(d, null, 2).slice(0, 800)}</pre>;
}

function ReviewCard({ r, onSubmitted }: { r: ReviewRec; onSubmitted: () => void }) {
  const opts = React.useMemo(() => candidateOptions(r), [r]);
  const [bd, setBd] = React.useState(r.manual_bd ?? "");
  const [note, setNote] = React.useState(r.manual_note ?? "");
  const [busy, setBusy] = React.useState(false);
  const listId = `review-cands-${r.review_key.replace(/[^a-zA-Z0-9]/g, "")}`;
  const noPicker = r.review_type === "HANDOVER_BOUNDARY";

  const submit = async (value: string) => {
    setBusy(true);
    try {
      const r2 = await feishuAction<{ warning?: string; mirrored: boolean; mirror_warning?: string }>("submit-judgment", {
        review_key: r.review_key,
        manual_bd: value,
        manual_note: note,
      });
      toast.success(value && value !== "忽略" ? `已判定归 ${value}` : "已标记忽略/已复核");
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
            <Badge variant={r.status === "OPEN" ? "destructive" : "outline"}>{r.status === "OPEN" ? "待处理" : "已裁决"}</Badge>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">最近发现 {(r.last_seen_at ?? "").slice(0, 10)}</span>
        </div>
        <DetailBlock r={r} />
        <div className="text-xs text-muted-foreground">系统默认：{r.default_resolution || "—"}{r.manual_bd ? ` · 当前判定：${r.manual_bd}${r.manual_note ? `（${r.manual_note}）` : ""}` : ""}</div>
        <div className="flex flex-wrap items-end gap-2 pt-1 border-t">
          {!noPicker ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">判定归属（可从建议中选，也可直接输入姓名）</span>
              <input
                list={listId}
                value={bd}
                onChange={(e) => setBd(e.target.value)}
                placeholder="姓名 / 忽略"
                className="h-8 w-48 rounded-md border border-input bg-transparent px-3 text-sm"
              />
              <datalist id={listId}>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                <option value="忽略" />
              </datalist>
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

export function ReviewPanel() {
  const [reviews, setReviews] = React.useState<ReviewRec[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);

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
  const visible = showResolved ? reviews : open;

  return (
    <Card>
      <CardHeader className="pb-3 space-y-2">
        <CardTitle className="text-base">
          归因审查 <span className="text-xs font-normal text-muted-foreground ml-1">待处理 {open.length} / 共 {reviews.length}</span>
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "只看待处理" : "查看全部（含已裁决）"}
          </Button>
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
          直接在下方每条审查项里选择归属并「提交判定」，会立即写入数据库并尽力同步到飞书「归因审查」表；也可以继续用飞书表 J/K 列人工填写后点「读回飞书表里的判定」。人工判定优先级最高且不会被自动覆盖。
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-16">加载中…</div>
        ) : visible.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-16">{showResolved ? "暂无审查项" : "没有待处理的审查项"}</div>
        ) : (
          visible.map((r) => <ReviewCard key={r.review_key} r={r} onSubmitted={load} />)
        )}
      </CardContent>
    </Card>
  );
}
