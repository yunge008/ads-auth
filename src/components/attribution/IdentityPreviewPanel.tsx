// GMV 归因 V3 阶段 2：身份层与归属区间的「只生成不使用」预演面板。
//
// 这个面板回答两个问题，且**不改变任何归因数字**：
//   1. 身份层把多少组名字判成了同一个达人？其中多少是靠 GMV MAX 昵称才连上的（达人改名）？
//   2. 换成「按发布日期查归属区间」之后，有多少达人的归属会和现在的单值归属不一样？
// 阶段 3 切引擎前，这两个数字就是影响面。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Fingerprint, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { type IdentityBuildResult, identityBuild } from "@/lib/attributionApi";

const DIFF_LABEL: Record<string, string> = {
  OWNER_DIFFERS: "归属不同",
  ONLY_IN_STAGES: "只在区间表里",
  ONLY_IN_OWNERSHIP: "只在现有归属里",
};

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-medium tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div> : null}
    </div>
  );
}

export function IdentityPreviewPanel() {
  const [country, setCountry] = React.useState("");
  const [busy, setBusy] = React.useState<"build" | "report" | null>(null);
  const [res, setRes] = React.useState<IdentityBuildResult | null>(null);

  const run = async (action: "build" | "report") => {
    setBusy(action);
    try {
      const r = await identityBuild(action, { country: country.trim() || undefined });
      setRes(r);
      toast.success(
        action === "build"
          ? `身份与区间已重建：${r.components ?? 0} 个达人实体 · ${r.stages ?? 0} 段归属区间（归因数字未改变）`
          : "已读取当前身份/区间统计",
      );
      if (r.identity_conflicts) {
        toast.warning(`${r.identity_conflicts} 个 VID 的名字对不上，相关达人需人工判定是不是同一个人（PENDING_IDENTITY）`);
      }
    } catch (e) {
      toast.error(`操作失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Fingerprint className="h-4 w-4" />达人身份层 · 归属区间预演（阶段 2）
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          只生成不使用：重建「同一个真人的多个名字」身份实体与「按发布日期分段的归属区间」，
          用来先看清阶段 3 切引擎的影响面。<b>本面板的任何操作都不会改变现在的归因数字。</b>
          站点留空 = 全站点；数据量大时建议按站点逐个跑。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">站点（留空 = 全部）</span>
            <Input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="PH / MX-NE …"
              className="h-8 w-40"
            />
          </div>
          <Button size="sm" onClick={() => run("build")} disabled={!!busy}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${busy === "build" ? "animate-spin" : ""}`} />重建身份与区间
          </Button>
          <Button size="sm" variant="outline" onClick={() => run("report")} disabled={!!busy}>
            查看差异报告
          </Button>
        </div>

        {res ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="达人实体" value={res.components ?? "—"} hint="连通分量数" />
              <Stat
                label="多名字实体"
                value={res.components_multi_name ?? "—"}
                hint={`其中靠 GMV MAX 昵称连上 ${res.components_linked_via_gmv_nickname ?? 0} 个`}
              />
              <Stat label="归属区间" value={res.stages ?? "—"} hint={`多段归属的达人 ${res.creators_with_multiple_stages ?? 0} 个`} />
              <Stat
                label="身份冲突"
                value={res.identity_conflicts ?? "—"}
                hint={`不可作锚点的 VID ${res.unusable_vids ?? 0} 个`}
              />
            </div>

            {res.diff_by_kind && Object.keys(res.diff_by_kind).length ? (
              <div className="text-xs">
                <div className="font-medium mb-1">区间 vs 现有单值归属的差异（最多列 500 行）</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(res.diff_by_kind).map(([k, v]) => (
                    <span key={k} className="rounded bg-muted px-2 py-1">
                      {DIFF_LABEL[k] ?? k}：{v}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {res.identity_merge_sample?.length ? (
              <div className="text-xs">
                <div className="font-medium mb-1">被判成同一个达人的名字（抽样）</div>
                <div className="max-h-64 overflow-auto rounded border">
                  <table className="w-full text-left">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-2 py-1 font-medium">站点</th>
                        <th className="px-2 py-1 font-medium">当前昵称</th>
                        <th className="px-2 py-1 font-medium">当前用户名</th>
                        <th className="px-2 py-1 font-medium">合并的名字</th>
                      </tr>
                    </thead>
                    <tbody>
                      {res.identity_merge_sample.map((m, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1">{m.site}</td>
                          <td className="px-2 py-1">{m.current_nickname ?? "—"}</td>
                          <td className="px-2 py-1">{m.current_username ?? "—"}</td>
                          <td className="px-2 py-1 text-muted-foreground">{m.names.join("　")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {res.diff_sample?.length ? (
              <div className="text-xs">
                <div className="font-medium mb-1">归属差异明细（抽样）</div>
                <div className="max-h-64 overflow-auto rounded border">
                  <table className="w-full text-left">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-2 py-1 font-medium">站点</th>
                        <th className="px-2 py-1 font-medium">达人</th>
                        <th className="px-2 py-1 font-medium">现在归</th>
                        <th className="px-2 py-1 font-medium">区间末段归</th>
                        <th className="px-2 py-1 font-medium">差异</th>
                      </tr>
                    </thead>
                    <tbody>
                      {res.diff_sample.map((d, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1">{d.country}</td>
                          <td className="px-2 py-1">{d.display_name || d.creator_key}</td>
                          <td className="px-2 py-1">{d.current_owner_bd ?? "—"}</td>
                          <td className="px-2 py-1">{d.stage_owner_bd ?? "—"}</td>
                          <td className="px-2 py-1 text-muted-foreground">{DIFF_LABEL[d.diff_kind] ?? d.diff_kind}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {res.note ? <p className="text-[11px] text-muted-foreground">{res.note}</p> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
