// 飞书表名称配置：系统到底动了飞书哪些表格、哪个 sheet、哪些列、会不会写回去，全在这一张表里。
//
// 为什么做成配置而不是硬编码：飞书那边一改表名，代码就读不到 —— 以前靠一张别名表去猜，
// 猜对一次的代价是真改名时静默读到另一张表、或者读空还以为「本期没数据」。
// 现在表名改了到这里改一行即可，不用改代码、不用重新部署。
//
// 「读取列项」与「映射」两列是给人看的说明：出问题时先来这里对一眼列位，
// 比翻代码快得多。列映射只读（改列位要同时改解析代码，不能只改文案）。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RotateCw, Save, Table2 } from "lucide-react";
import { toast } from "sonner";
import { type FeishuSheetConfig, feishuAction } from "@/lib/attributionApi";

export function FeishuSheetConfigPanel() {
  const [rows, setRows] = React.useState<FeishuSheetConfig[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [openMap, setOpenMap] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await feishuAction<{ configs: FeishuSheetConfig[] }>("list-sheet-config");
      setRows(r.configs ?? []);
      setDirty(false);
    } catch (e) {
      toast.error(`读取飞书表配置失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const edit = (key: string, patch: Partial<FeishuSheetConfig>) => {
    setRows((old) => old.map((r) => (r.config_key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const save = async () => {
    const bad = rows.find((r) => !r.sheet_name.trim());
    if (bad) {
      toast.error(`「${bad.config_key}」的 sheet 名称不能为空`);
      return;
    }
    setSaving(true);
    try {
      const r = await feishuAction<{ saved: number }>("save-sheet-config", { configs: rows });
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
          sheet 名称按去空白后<b>精确匹配</b>，对不上会直接报错并列出该表格现有的 sheet —— 不做别名猜测，
          猜错比报错更难查。带 <Badge variant="outline" className="h-4 px-1 text-[10px]">读写</Badge> 的表系统会写回去，
          人工在里面手填的内容可能被覆盖。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading || saving}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving || loading}>
            <Save className={`h-4 w-4 mr-1.5 ${saving ? "animate-pulse" : ""}`} />保存修改
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
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-left font-normal py-1 pr-3">飞书表格名称</th>
                  <th className="text-left font-normal pr-3">飞书 sheet 名称</th>
                  <th className="text-left font-normal pr-3">读取列范围</th>
                  <th className="text-left font-normal pr-3">读写</th>
                  <th className="text-left font-normal pr-3">说明备注</th>
                  <th className="text-left font-normal">列映射</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <React.Fragment key={r.config_key}>
                    <tr className="border-b last:border-0 align-top">
                      <td className="py-1.5 pr-3">
                        <Input
                          value={r.spreadsheet_label}
                          onChange={(e) => edit(r.config_key, { spreadsheet_label: e.target.value })}
                          className="h-7 w-40 text-xs"
                        />
                        {r.spreadsheet_env ? (
                          <div className="text-[10px] text-muted-foreground mt-0.5">token: {r.spreadsheet_env}</div>
                        ) : (
                          <div className="text-[10px] text-muted-foreground mt-0.5">token: 主表格</div>
                        )}
                      </td>
                      <td className="pr-3">
                        <Input
                          value={r.sheet_name}
                          onChange={(e) => edit(r.config_key, { sheet_name: e.target.value })}
                          className="h-7 w-44 text-xs"
                        />
                        <div className="text-[10px] text-muted-foreground mt-0.5">key: {r.config_key}</div>
                      </td>
                      <td className="pr-3">
                        <Input
                          value={r.read_range}
                          onChange={(e) => edit(r.config_key, { read_range: e.target.value })}
                          className="h-7 w-24 text-xs"
                        />
                      </td>
                      <td className="pr-3 whitespace-nowrap py-1.5">
                        {r.access === "READWRITE" ? (
                          <Badge variant="destructive" className="h-5">读写</Badge>
                        ) : (
                          <Badge variant="outline" className="h-5">只读</Badge>
                        )}
                      </td>
                      <td className="pr-3">
                        <Input
                          value={r.note}
                          onChange={(e) => edit(r.config_key, { note: e.target.value })}
                          className="h-7 w-[26rem] text-xs"
                        />
                      </td>
                      <td className="py-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setOpenMap(openMap === r.config_key ? null : r.config_key)}
                        >
                          {openMap === r.config_key ? "收起" : `映射（${r.column_map?.length ?? 0}）`}
                        </Button>
                      </td>
                    </tr>
                    {openMap === r.config_key ? (
                      <tr className="border-b bg-muted/30">
                        <td colSpan={6} className="p-3">
                          <div className="text-xs font-medium mb-1">
                            {r.spreadsheet_label} · {r.sheet_name} · {r.read_range || "范围由代码决定"}
                          </div>
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
                                  <td>{c.note}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="text-[11px] text-muted-foreground mt-2">
                            列映射只读：改列位必须同时改解析代码，光改这里的文案不会改变实际读取行为。
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
