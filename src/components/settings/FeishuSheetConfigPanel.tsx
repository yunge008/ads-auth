// 飞书表名称配置：系统到底动了飞书哪些表格、哪个 sheet、哪些列、会不会写回去，全在这一张表里。
//
// 为什么做成配置而不是硬编码：飞书那边一改表名，代码就读不到 —— 以前靠一张别名表去猜，
// 猜对一次的代价是真改名时静默读到另一张表、或者读空还以为「本期没数据」。
// 现在表名改了到这里改一行即可，不用改代码、不用重新部署。
//
// 哪些能改、哪些不能：
//   · 可改：飞书表格名称、sheet 名称、说明备注 —— 这些只是「去哪儿找」和给人看的说明。
//   · 只读：code-key（代码里引用这行配置的标识）、读取列范围、读写标记、列映射 ——
//     这几样都写死在解析代码里，在界面上改只会让配置表说的和系统做的不一致，比不写还糟。
// 交互对齐「人员表」：平时是纯展示表格，点右侧铅笔才进入编辑。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, Pencil, RotateCw, Save, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { type FeishuSheetConfig, feishuAction } from "@/lib/attributionApi";

/** 按飞书表格名分组、组内按 sort_order：同一个表格的 sheet 要挨在一起。名称留空（还没提供的表）排最后。 */
function sortRows(rows: FeishuSheetConfig[]): FeishuSheetConfig[] {
  return [...rows].sort((a, b) => {
    const ea = a.spreadsheet_label.trim() ? 0 : 1;
    const eb = b.spreadsheet_label.trim() ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const byLabel = a.spreadsheet_label.localeCompare(b.spreadsheet_label, "zh");
    if (byLabel !== 0) return byLabel;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.config_key.localeCompare(b.config_key);
  });
}

export function FeishuSheetConfigPanel() {
  const [server, setServer] = React.useState<FeishuSheetConfig[]>([]);
  const [drafts, setDrafts] = React.useState<FeishuSheetConfig[] | null>(null);
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [openMap, setOpenMap] = React.useState<string | null>(null);

  const rows = sortRows(drafts ?? server);
  const dirty = drafts !== null;

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await feishuAction<{ configs: FeishuSheetConfig[] }>("list-sheet-config");
      setServer(r.configs ?? []);
      setDrafts(null);
      setEditingKey(null);
    } catch (e) {
      toast.error(`读取飞书表配置失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const startEdit = (key: string) => {
    if (!dirty) setDrafts([...server]);
    setEditingKey(key);
  };
  const updateRow = (key: string, patch: Partial<FeishuSheetConfig>) => {
    const base = drafts ?? server;
    setDrafts(base.map((r) => (r.config_key === key ? { ...r, ...patch } : r)));
  };
  const cancel = () => { setDrafts(null); setEditingKey(null); };

  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    try {
      const r = await feishuAction<{ saved: number }>("save-sheet-config", { configs: drafts });
      toast.success(`已保存 ${r.saved} 条配置，下一次同步立即生效（不用重新部署）`);
      await load();
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Table2 className="h-4 w-4" />飞书表名称
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          系统读写的全部飞书表格与 sheet 都在这里。<b>飞书那边改了表名，来这里改一行即可</b>，不用改代码、不用重新部署。
          sheet 名称按去空白后<b>精确匹配</b>，对不上会直接报错并列出该表格现有的 sheet —— 不做别名猜测，猜错比报错更难查。
          带 <Badge variant="outline" className="h-4 px-1 text-[10px]">读写</Badge> 的表系统会写回去，人工手填的内容可能被覆盖。
          <b>读取列范围与列映射只读</b>：它们写死在解析代码里，改这里不改变实际读取行为。
          表格名称或 sheet 名称留空的行 = <b>还没提供给系统</b>，不参与匹配，填上并保存后才生效。
          带 <code>{"{}"}</code> 占位符的是<b>每人一张的 sheet</b>（建联-同事姓名 / 剪辑姓名），
          真实名称来自「人员表」，这里只说明这类表读哪些列，改不了。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading || saving}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
          {dirty ? <span className="text-xs text-amber-600">有未保存的修改</span> : null}
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-12">加载中…</div>
        ) : !rows.length ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            还没有配置数据，请先执行 migration <code>20260918170000_feishu_sheet_config.sql</code>
          </div>
        ) : (
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">key</TableHead>
                  <TableHead className="w-44">飞书表格名称</TableHead>
                  <TableHead className="w-44">飞书 sheet 名称</TableHead>
                  <TableHead className="w-24">读取列范围</TableHead>
                  <TableHead className="w-20">读写</TableHead>
                  <TableHead>说明备注</TableHead>
                  <TableHead className="w-24">列映射</TableHead>
                  <TableHead className="w-14 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isEditing = editingKey === r.config_key;
                  const pending = !r.spreadsheet_label.trim() || !r.sheet_name.trim();
                  // 带 {占位符} 的是「每人一张」的 sheet（建联-{同事姓名} / {剪辑姓名}）：
                  // 真实 sheet 名来自「人员表」，这里的模板只说明这类表读哪些列，不参与匹配，所以不给改。
                  const isTemplate = /[{}]/.test(r.sheet_name);
                  return (
                    <React.Fragment key={r.config_key}>
                      <TableRow className={`align-top ${pending ? "bg-amber-50/60" : ""}`}>
                        <TableCell className="py-2">
                          <code className="text-[11px]">{r.config_key}</code>
                          {pending ? (
                            <div className="text-[10px] text-amber-700 mt-0.5">待提供</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="py-2">
                          {isEditing ? (
                            <Input
                              value={r.spreadsheet_label}
                              onChange={(e) => updateRow(r.config_key, { spreadsheet_label: e.target.value })}
                              placeholder="（还没提供可留空）"
                              className="h-8 text-xs"
                            />
                          ) : (
                            <span className="text-xs">
                              {r.spreadsheet_label || <span className="text-muted-foreground">—</span>}
                            </span>
                          )}
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            token: {r.spreadsheet_env || "主表格"}
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          {isEditing && !isTemplate ? (
                            <Input
                              value={r.sheet_name}
                              onChange={(e) => updateRow(r.config_key, { sheet_name: e.target.value })}
                              placeholder="（还没提供可留空）"
                              className="h-8 text-xs"
                            />
                          ) : (
                            <span className="text-xs">
                              {r.sheet_name || <span className="text-muted-foreground">—</span>}
                            </span>
                          )}
                          {isTemplate ? (
                            // 每人一张的 sheet：真名在人员表里，这里存的是模板，改它不会改变读哪张 sheet
                            <div className="text-[10px] text-amber-700 mt-0.5">
                              每人一张，名称取自「人员表」
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {r.read_range || "由代码决定"}
                        </TableCell>
                        <TableCell className="py-2 whitespace-nowrap">
                          {r.access === "READWRITE" ? (
                            <Badge variant="destructive" className="h-5">读写</Badge>
                          ) : (
                            <Badge variant="outline" className="h-5">只读</Badge>
                          )}
                        </TableCell>
                        <TableCell className="py-2">
                          {isEditing ? (
                            <Textarea
                              value={r.note}
                              onChange={(e) => updateRow(r.config_key, { note: e.target.value })}
                              rows={4}
                              className="text-xs min-h-[5rem]"
                            />
                          ) : (
                            // 备注是「这张表用来做什么」的唯一记录，截断了等于没写，这里整段换行显示
                            <span className="text-xs whitespace-pre-wrap break-words leading-relaxed">
                              {r.note || <span className="text-muted-foreground">—</span>}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="py-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setOpenMap(openMap === r.config_key ? null : r.config_key)}
                          >
                            {openMap === r.config_key ? "收起" : `映射（${r.column_map?.length ?? 0}）`}
                          </Button>
                        </TableCell>
                        <TableCell className="py-2 text-right">
                          {isEditing ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => setEditingKey(null)}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => startEdit(r.config_key)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {openMap === r.config_key ? (
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={8} className="p-3">
                            <div className="text-xs font-medium mb-1">
                              {r.spreadsheet_label || "（表格待提供）"} · {r.sheet_name || "（sheet 待提供）"} ·{" "}
                              {r.read_range || "范围由代码决定"}
                            </div>
                            {(r.column_map ?? []).length ? (
                              <table className="text-xs w-full">
                                <thead>
                                  <tr className="text-muted-foreground border-b">
                                    <th className="text-left font-normal py-1 pr-3 w-32">列</th>
                                    <th className="text-left font-normal pr-3 w-40">对应字段</th>
                                    <th className="text-left font-normal">含义 / 注意事项</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(r.column_map ?? []).map((c, i) => (
                                    <tr key={i} className="border-b last:border-0">
                                      <td className="py-1 pr-3 font-medium whitespace-nowrap">{c.col}</td>
                                      <td className="pr-3 text-muted-foreground whitespace-nowrap">{c.field}</td>
                                      <td className="whitespace-pre-wrap break-words">{c.note}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <div className="text-xs text-muted-foreground">这张表还没有列映射（通常是还没接入）。</div>
                            )}
                            <div className="text-[11px] text-muted-foreground mt-2">
                              列映射与读取列范围只读：改列位必须同时改解析代码，光改这里的文案不会改变实际读取行为。
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex justify-end gap-2">
          {dirty && (
            <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
              <X className="h-4 w-4 mr-1" />取消
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!dirty || saving || loading}>
            <Save className={`h-4 w-4 mr-1 ${saving ? "animate-pulse" : ""}`} />保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
