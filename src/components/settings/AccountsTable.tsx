import { useState } from "react";
import { Plus, Trash2, Save, Pencil, Check, X, RefreshCw } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { AuthAccount } from "@/lib/types";
import { useAccounts, useBCAdvertisers } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";

type Draft = AuthAccount & { _new?: boolean };

export function AccountsTable() {
  const { accounts, save } = useAccounts();
  const { advertisers, save: saveAdv } = useBCAdvertisers();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const rows = drafts ?? accounts;
  const dirty = drafts !== null;

  const startEdit = () => setDrafts([...accounts]);

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

  const handleSyncBC = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("bc-list-advertisers", { body: {} });
      if (error) throw error;
      const list = (data?.advertisers ?? []) as { advertiser_id: string; advertiser_name: string; status?: string }[];
      saveAdv(list);
      toast.success(`已同步 ${list.length} 个 BC 广告户`);
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          授权账户表
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            （BC 已同步 {advertisers.length} 个广告户）
          </span>
        </CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleSyncBC} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
            同步 BC 广告户
          </Button>
          <Button size="sm" variant="outline" onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-1" />
            新增
          </Button>
        </div>
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
                          advertisers.length > 0 ? (
                            <Select
                              value={row.advertiser_id || undefined}
                              onValueChange={(id) => {
                                const adv = advertisers.find((a) => a.advertiser_id === id);
                                if (adv) {
                                  updateRow(row.id, {
                                    advertiser_id: adv.advertiser_id,
                                    advertiser_name: adv.advertiser_name,
                                  });
                                }
                              }}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder="选择广告户" />
                              </SelectTrigger>
                              <SelectContent>
                                {advertisers.map((a) => (
                                  <SelectItem key={a.advertiser_id} value={a.advertiser_id}>
                                    {a.advertiser_name}
                                    <span className="ml-2 text-xs text-muted-foreground font-mono">
                                      {a.advertiser_id}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              value={row.advertiser_name}
                              onChange={(e) =>
                                updateRow(row.id, { advertiser_name: e.target.value })
                              }
                              placeholder="先点「同步 BC 广告户」"
                              className="h-8"
                            />
                          )
                        ) : (
                          row.advertiser_name || <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">
                          {row.advertiser_id || "—"}
                        </span>
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
