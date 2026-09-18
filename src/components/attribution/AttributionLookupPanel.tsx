// 归因查询：输入一个 VID 或达人昵称，回答「它归给了谁、哪个时间段、凭什么」。
//
// 三块一次给全，对应人脑里的三个问题：
//   1. 归因结果 —— 每个月的快照里算给了谁（按月分段，这就是「对应时间段」）
//   2. 登记记录 —— 建联表/授权记录/剪辑表里谁登记过它、什么日期（判定的原始依据）
//   3. 当前归属 —— creator_ownership 里现在归谁、保护期算到哪天
//
// 只查最新一次月度快照：同一个月重算过多次的话，不去重会同一条数据出好几行。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { type AttributionLookup, attributionLookup } from "@/lib/attributionApi";

const PAGE_SIZE = 10;

const BUCKET_LABELS: Record<string, string> = {
  STAFF: "已归因",
  PRODUCT_CARD: "商品卡片",
  OTHER: "其他类型",
  UNMATCHED: "未建联",
};
const MATCH_LABELS: Record<string, string> = {
  VID: "VID 匹配",
  REGISTRY: "建联昵称",
  ALIAS_VID: "别名推断",
  ALIAS_MANUAL: "人工判定",
};

const dash = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const money = (n: unknown) => (typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");

export function AttributionLookupPanel() {
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [res, setRes] = React.useState<AttributionLookup | null>(null);
  const [lastQ, setLastQ] = React.useState("");

  const search = React.useCallback(async (query: string, p: number) => {
    const term = query.trim();
    if (!term) {
      toast.warning("请输入 VID 或达人昵称");
      return;
    }
    setLoading(true);
    try {
      const r = await attributionLookup(term, PAGE_SIZE, (p - 1) * PAGE_SIZE);
      setRes(r);
      setLastQ(term);
      setPage(p);
      if (!r.total) toast.info(`「${term}」在归因快照里没有记录（下方仍会列出登记与当前归属，如果有的话）`);
    } catch (e) {
      toast.error(`查询失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const total = res?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="h-4 w-4" />归因查询
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            输入 <b>VID</b>（15–20 位数字，精确匹配）或<b>达人昵称/用户名</b>（模糊匹配），
            查它每个月归给了谁、凭什么归的，以及登记表里的原始依据。只查每个月最新一次快照。
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void search(q, 1); }}
            placeholder="7412345678901234567 或 王姐好物"
            className="h-9 w-80"
          />
          <Button size="sm" onClick={() => void search(q, 1)} disabled={loading}>
            <Search className={`h-4 w-4 mr-1.5 ${loading ? "animate-pulse" : ""}`} />查询
          </Button>
          {res ? (
            <span className="text-xs text-muted-foreground">
              「{res.query}」{res.is_vid ? "按 VID 精确匹配" : "按名字模糊匹配"} · 归因记录 {total} 条
            </span>
          ) : null}
        </CardContent>
      </Card>

      {res ? (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">归因结果（按月）</CardTitle>
            </CardHeader>
            <CardContent>
              {!res.rows?.length ? (
                <div className="text-sm text-muted-foreground text-center py-10">这个查询在归因快照里没有记录</div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="text-xs w-full">
                      <thead>
                        <tr className="text-muted-foreground border-b">
                          <th className="text-left font-normal py-1 pr-3">月份</th>
                          <th className="text-left font-normal pr-3">站点</th>
                          <th className="text-left font-normal pr-3">归属</th>
                          <th className="text-left font-normal pr-3">角色</th>
                          <th className="text-left font-normal pr-3">凭什么</th>
                          <th className="text-left font-normal pr-3">达人昵称</th>
                          <th className="text-left font-normal pr-3">VID</th>
                          <th className="text-left font-normal pr-3">类型</th>
                          <th className="text-right font-normal pr-3">行数</th>
                          <th className="text-right font-normal">GMV(USD)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {res.rows.map((r, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="py-1 pr-3 tabular-nums whitespace-nowrap">{r.month}</td>
                            <td className="pr-3 whitespace-nowrap">{dash(r.country)}</td>
                            <td className="pr-3 font-medium whitespace-nowrap">
                              {r.staff ? r.staff : <span className="text-muted-foreground">{BUCKET_LABELS[r.bucket] ?? r.bucket}</span>}
                              {r.handover_applied ? <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">交接分段</Badge> : null}
                            </td>
                            <td className="pr-3 whitespace-nowrap">{r.role === "EDITOR" ? "剪辑" : r.role === "BD" ? "BD" : "—"}</td>
                            <td className="pr-3 whitespace-nowrap">{r.match_type ? (MATCH_LABELS[r.match_type] ?? r.match_type) : (BUCKET_LABELS[r.bucket] ?? r.bucket)}</td>
                            <td className="pr-3">{dash(r.account_name)}</td>
                            <td className="pr-3 tabular-nums text-muted-foreground">{dash(r.vid)}</td>
                            <td className="pr-3 whitespace-nowrap">{dash(r.creative_type)}</td>
                            <td className="pr-3 text-right tabular-nums">{r.rows_count}</td>
                            <td className="text-right tabular-nums">{money(r.gmv_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} 条 / 共 {total} 条
                    </span>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => void search(lastQ, page - 1)}>
                        <ChevronLeft className="h-4 w-4" />上一页
                      </Button>
                      <span className="text-xs tabular-nums">{page} / {pageCount}</span>
                      <Button size="sm" variant="outline" disabled={page >= pageCount || loading} onClick={() => void search(lastQ, page + 1)}>
                        下一页<ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                登记记录 <span className="text-xs font-normal text-muted-foreground">飞书三处登记里谁动过这个达人 —— 归因判定的原始依据</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!res.registry?.length ? (
                <div className="text-sm text-muted-foreground text-center py-8">登记表里没有这个达人 / VID（这正是「未建联」的原因）</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="text-muted-foreground border-b">
                        <th className="text-left font-normal py-1 pr-3">登记人</th>
                        <th className="text-left font-normal pr-3">角色</th>
                        <th className="text-left font-normal pr-3">站点</th>
                        <th className="text-left font-normal pr-3">发样日</th>
                        <th className="text-left font-normal pr-3">登记日</th>
                        <th className="text-left font-normal pr-3">昵称</th>
                        <th className="text-left font-normal pr-3">用户名</th>
                        <th className="text-left font-normal pr-3">VID</th>
                        <th className="text-left font-normal">来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {res.registry.map((g, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1 pr-3 font-medium whitespace-nowrap">{g.staff_name}</td>
                          <td className="pr-3 whitespace-nowrap">{g.role === "EDITOR" ? "剪辑" : "BD"}</td>
                          <td className="pr-3 whitespace-nowrap">{dash(g.country)}</td>
                          <td className="pr-3 tabular-nums whitespace-nowrap">{dash(g.sample_date)}</td>
                          <td className="pr-3 tabular-nums whitespace-nowrap">{dash(g.register_date)}</td>
                          <td className="pr-3">{dash(g.nickname_raw)}</td>
                          <td className="pr-3">{dash(g.handle_raw)}</td>
                          <td className="pr-3 tabular-nums text-muted-foreground">{dash(g.vid)}</td>
                          <td className="text-muted-foreground whitespace-nowrap">{g.source_sheet}{g.row_number ? ` 第${g.row_number}行` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {res.ownership?.length ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  当前归属 <span className="text-xs font-normal text-muted-foreground">保护期解析出来的「现在归谁」</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="text-muted-foreground border-b">
                        <th className="text-left font-normal py-1 pr-3">匹配键</th>
                        <th className="text-left font-normal pr-3">类型</th>
                        <th className="text-left font-normal pr-3">站点</th>
                        <th className="text-left font-normal pr-3">当前归属</th>
                        <th className="text-left font-normal pr-3">首次建联</th>
                        <th className="text-left font-normal pr-3">最近动作</th>
                        <th className="text-right font-normal">转移次数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {res.ownership.map((o, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1 pr-3">{o.display_name || o.match_key}</td>
                          <td className="pr-3 whitespace-nowrap">{o.key_type === "NICKNAME" ? "昵称" : "用户名"}</td>
                          <td className="pr-3 whitespace-nowrap">{dash(o.country)}</td>
                          <td className="pr-3 font-medium whitespace-nowrap">{o.owner_bd}</td>
                          <td className="pr-3 tabular-nums whitespace-nowrap">{dash(o.first_register_date)}</td>
                          <td className="pr-3 tabular-nums whitespace-nowrap">{dash(o.owner_last_register_date)}</td>
                          <td className="text-right tabular-nums">{o.transfer_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
