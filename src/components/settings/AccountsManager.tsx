import { useEffect, useState } from "react";
import { Plus, Trash2, Save, Pencil, X, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { TABS } from "@/lib/tabs";

type Account = {
  id: string;
  name: string;
  is_admin: boolean;
  tab_permissions: string[];
  active: boolean;
};

type Draft = Account & { passcode?: string; isNew?: boolean };

export function AccountsManager() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const { accounts } = await invokeFn<{ accounts: Account[] }>(
        "app-accounts",
        { op: "list" },
      );
      setAccounts(accounts ?? []);
    } catch (e) {
      toast.error(`加载账号失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const startCreate = () =>
    setEditing({
      id: "",
      name: "",
      is_admin: false,
      tab_permissions: [],
      active: true,
      passcode: "",
      isNew: true,
    });

  const startEdit = (a: Account) =>
    setEditing({ ...a, passcode: "" });

  const toggleTab = (key: string) => {
    if (!editing) return;
    const has = editing.tab_permissions.includes(key);
    setEditing({
      ...editing,
      tab_permissions: has
        ? editing.tab_permissions.filter((k) => k !== key)
        : [...editing.tab_permissions, key],
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error("请输入名称");
      return;
    }
    if (editing.isNew && !editing.passcode?.trim()) {
      toast.error("新账号必须设置密码");
      return;
    }
    try {
      const op = editing.isNew ? "create" : "update";
      await invokeFn("app-accounts", {
        op,
        account: {
          id: editing.isNew ? undefined : editing.id,
          name: editing.name.trim(),
          passcode: editing.passcode?.trim() || undefined,
          is_admin: editing.is_admin,
          tab_permissions: editing.tab_permissions,
          active: editing.active,
        },
      });
      toast.success(editing.isNew ? "已创建账号" : "已更新账号");
      setEditing(null);
      await reload();
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    }
  };

  const handleDelete = async (a: Account) => {
    if (!confirm(`确认删除账号「${a.name}」？`)) return;
    try {
      await invokeFn("app-accounts", { op: "delete", id: a.id });
      toast.success("已删除");
      await reload();
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">账号管理</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            管理员可创建账号、分配不同 Tab 的访问权限。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={startCreate}>
          <Plus className="h-4 w-4 mr-1" />
          新增账号
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>可访问 Tab</TableHead>
                <TableHead className="w-16">启用</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-center text-sm text-muted-foreground">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-center text-sm text-muted-foreground">
                    暂无账号（当前仍可使用环境密码登录）
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell>
                      {a.is_admin ? (
                        <span className="text-primary text-xs">管理员</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">普通</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {a.is_admin ? (
                          <span className="text-xs text-muted-foreground">全部</span>
                        ) : a.tab_permissions.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          a.tab_permissions.map((k) => {
                            const t = TABS.find((x) => x.key === k);
                            return (
                              <span
                                key={k}
                                className="rounded bg-muted px-1.5 py-0.5 text-xs"
                              >
                                {t?.label ?? k}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch checked={a.active} disabled />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={() => startEdit(a)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(a)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {editing && (
          <div className="border rounded-md p-4 space-y-3 bg-muted/30">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {editing.isNew ? "新增账号" : `编辑账号：${editing.name}`}
              </h3>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">名称</label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="李四"
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground inline-flex items-center gap-1">
                  <KeyRound className="h-3 w-3" />
                  密码
                  {!editing.isNew && (
                    <span className="text-[10px]">（留空则不修改）</span>
                  )}
                </label>
                <Input
                  type="text"
                  value={editing.passcode ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, passcode: e.target.value })
                  }
                  placeholder={editing.isNew ? "请输入密码" : "留空保持原密码"}
                  className="h-8"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <label className="inline-flex items-center gap-2 text-sm">
                <Switch
                  checked={editing.is_admin}
                  onCheckedChange={(v) => setEditing({ ...editing, is_admin: v })}
                />
                设为管理员（拥有全部 Tab）
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <Switch
                  checked={editing.active}
                  onCheckedChange={(v) => setEditing({ ...editing, active: v })}
                />
                启用
              </label>
            </div>

            {!editing.is_admin && (
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">
                  可访问 Tab
                </label>
                <div className="flex flex-wrap gap-3">
                  {TABS.map((t) => (
                    <label
                      key={t.key}
                      className="inline-flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={editing.tab_permissions.includes(t.key)}
                        onCheckedChange={() => toggleTab(t.key)}
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button size="sm" onClick={handleSave}>
                <Save className="h-4 w-4 mr-1" />
                保存
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
