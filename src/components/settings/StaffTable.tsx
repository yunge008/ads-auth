import { useState } from "react";
import { Plus, Trash2, Save, Pencil, Check, X, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import type { StaffSheet } from "@/lib/types";
import { useStaff } from "@/lib/store";

export function StaffTable() {
  const { staff, save } = useStaff();
  const [drafts, setDrafts] = useState<StaffSheet[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const rows = drafts ?? staff;
  const dirty = drafts !== null;

  const startEdit = () => setDrafts([...staff]);

  const handleAdd = () => {
    const next: StaffSheet = {
      id: crypto.randomUUID(),
      name: "",
      sheet_name: "",
      active: true,
      role: "BD",
    };
    setDrafts([...(drafts ?? staff), next]);
    setEditingId(next.id);
  };


  const updateRow = (id: string, patch: Partial<StaffSheet>) => {
    const base = drafts ?? staff;
    setDrafts(base.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: string) => {
    const base = drafts ?? staff;
    setDrafts(base.filter((r) => r.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const handleSave = async () => {
    if (!drafts) return;
    const cleaned = drafts.filter((r) => r.name.trim() && r.sheet_name.trim());
    try {
      await save(cleaned);
      setDrafts(null);
      setEditingId(null);
      toast.success(`已保存 ${cleaned.length} 位人员`);
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    }
  };

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">人员表</CardTitle>
        <Button size="sm" variant="outline" onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-1" />
          新增
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>sheet名</TableHead>
                <TableHead className="w-24">角色</TableHead>
                <TableHead className="w-16">启用</TableHead>
                <TableHead className="w-20 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                    暂无人员，点击「新增」添加
                  </TableCell>
                </TableRow>
              ) : (

                rows.map((row) => {
                  const isEditing = editingId === row.id;
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            value={row.name}
                            onChange={(e) => updateRow(row.id, { name: e.target.value })}
                            placeholder="张三"
                            className="h-8"
                          />
                        ) : (
                          row.name || <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            value={row.sheet_name}
                            onChange={(e) => updateRow(row.id, { sheet_name: e.target.value })}
                            placeholder="张三-达人"
                            className="h-8"
                          />
                        ) : (
                          row.sheet_name || <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <select
                          value={row.role ?? "BD"}
                          onChange={(e) => {
                            if (!dirty) startEdit();
                            updateRow(row.id, { role: e.target.value as "BD" | "EDITOR" });
                          }}
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                        >
                          <option value="BD">BD</option>
                          <option value="EDITOR">剪辑</option>
                        </select>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={row.active}
                          onCheckedChange={(v) => {
                            if (!dirty) startEdit();
                            updateRow(row.id, { active: v });
                          }}
                        />
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          {isEditing ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => setEditingId(null)}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => {
                                if (!dirty) startEdit();
                                setEditingId(row.id);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                            onClick={() => {
                              if (!dirty) startEdit();
                              removeRow(row.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            提示：sheet名必须与飞书表格中的 Tab 名称完全一致，否则无法读取对应人员的数据。
          </span>
        </div>

        <div className="flex justify-end gap-2">
          {dirty && (
            <Button variant="outline" size="sm" onClick={() => { setDrafts(null); setEditingId(null); }}>
              <X className="h-4 w-4 mr-1" />
              取消
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={!dirty}>
            <Save className="h-4 w-4 mr-1" />
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
