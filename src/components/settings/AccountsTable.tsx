import { useState } from "react";
import { Plus, Trash2, Save, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type { AuthAccount } from "@/lib/types";
import { useAccounts } from "@/lib/store";

type Draft = AuthAccount & { _new?: boolean };

export function AccountsTable() {
  const { accounts, save } = useAccounts();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const rows = drafts ?? accounts;
  const dirty = drafts !== null;

  const startEdit = () => {
    setDrafts([...accounts]);
  };

  const handleAdd = () => {
    const next: Draft = {
      id: crypto.randomUUID(),
      country: "",
      advertiser_name: "",
      advertiser_id: "",
      _new: true,
    };
    setDrafts([...(drafts ?? accounts), next]);
    setEditingId(next.id);
  };

  const updateRow = (id: string, patch: Partial<AuthAccount>) => {
    const base = drafts ?? accounts;
    setDrafts(base.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: string) => {
    const base = drafts ?? accounts;
    setDrafts(base.filter((r) => r.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const handleSave = () => {
    if (!drafts) return;
    const cleaned = drafts.filter(
      (r) => r.country.trim() && r.advertiser_name.trim() && r.advertiser_id.trim(),
    );
    save(cleaned.map(({ _new, ...r }) => r));
    setDrafts(null);
    setEditingId(null);
    toast.success(`已保存 ${cleaned.length} 条授权账户`);
  };

  const handleCancel = () => {
    setDrafts(null);
    setEditingId(null);
  };

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">授权账户表</CardTitle>
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
                <TableHead className="w-32">国家</TableHead>
                <TableHead>广告户名称</TableHead>
                <TableHead>广告户ID</TableHead>
                <TableHead className="w-28 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-20 text-center text-sm text-muted-foreground">
                    暂无授权账户，点击「新增」添加
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
                            value={row.country}
                            onChange={(e) => updateRow(row.id, { country: e.target.value })}
                            placeholder="美国 / US"
                            className="h-8"
                          />
                        ) : (
                          row.country || <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            value={row.advertiser_name}
                            onChange={(e) =>
                              updateRow(row.id, { advertiser_name: e.target.value })
                            }
                            placeholder="美国广告户"
                            className="h-8"
                          />
                        ) : (
                          row.advertiser_name || <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            value={row.advertiser_id}
                            onChange={(e) => updateRow(row.id, { advertiser_id: e.target.value })}
                            placeholder="7xxxxxxxxxxxx"
                            className="h-8 font-mono text-xs"
                          />
                        ) : (
                          <span className="font-mono text-xs">
                            {row.advertiser_id || "—"}
                          </span>
                        )}
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

        <div className="flex justify-end gap-2">
          {dirty && (
            <Button variant="outline" size="sm" onClick={handleCancel}>
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
