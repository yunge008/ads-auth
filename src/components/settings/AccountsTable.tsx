import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Save, Pencil, Check, X, RefreshCw, Link2, Unlink } from "lucide-react";
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { AuthAccount, BCAdvertiser } from "@/lib/types";
import { useAccounts, useBCAdvertisers } from "@/lib/store";
import { invokeFn } from "@/lib/api";

type Draft = AuthAccount & { _new?: boolean };

type Connection = {
  id: string;
  label: string;
  bc_id: string | null;
  advertiser_ids: string[];
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function AccountsTable() {
  const { accounts, save } = useAccounts();
  const { advertisers, save: saveAdv } = useBCAdvertisers();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [conns, setConns] = useState<Connection[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectLabel, setConnectLabel] = useState("");
  const [connecting, setConnecting] = useState(false);

  const rows = drafts ?? accounts;
  const dirty = drafts !== null;

  const loadConns = useCallback(async () => {
    try {
      const data = await invokeFn<{ connections: Connection[] }>("tiktok-connections", { op: "list" });
      setConns(data.connections ?? []);
    } catch (e) {
      // 静默 — 没填密码时不打扰
      console.warn("load connections", (e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadConns();
    // 回调成功后会 sessionStorage 设标记
    const flag = sessionStorage.getItem("tt_connect_done");
    if (flag) {
      sessionStorage.removeItem("tt_connect_done");
      toast.success(`新增连接：${flag}`);
      loadConns();
      handleSyncBC();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConns]);

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
      const data = await invokeFn<{ advertisers: BCAdvertiser[]; warning?: string }>("bc-list-advertisers");
      const list = data.advertisers ?? [];
      saveAdv(list);
      if (data.warning) toast.warning(data.warning);
      else toast.success(`已同步 ${list.length} 个 BC 广告户`);
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleStartConnect = async () => {
    const label = connectLabel.trim();
    if (!label) {
      toast.error("请填一个标签（如 BC-A）");
      return;
    }
    setConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/oauth/tiktok/callback`;
      const data = await invokeFn<{ authorize_url: string }>("tiktok-oauth-init", {
        label,
        redirect_uri: redirectUri,
      });
      // 新标签页打开，避免预览 iframe 被 TikTok 拒绝（X-Frame-Options）
      window.open(data.authorize_url, "_blank", "noopener");
      setConnecting(false);
      setConnectOpen(false);
      toast.info("已在新标签页打开 TikTok 授权页，完成后回到本页面会自动刷新连接列表");
    }
  };

  const handleDeleteConn = async (id: string, label: string) => {
    if (!confirm(`删除连接「${label}」？该 BC 下的广告户授权将立即失效。`)) return;
    try {
      await invokeFn("tiktok-connections", { op: "delete", id });
      toast.success("已删除");
      loadConns();
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* TikTok 连接管理 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            TikTok 授权连接
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              （共 {conns.length} 个，覆盖 {conns.reduce((s, c) => s + c.advertiser_ids.length, 0)} 个广告户）
            </span>
          </CardTitle>
          <Button size="sm" onClick={() => setConnectOpen(true)}>
            <Link2 className="h-4 w-4 mr-1" />
            连接 TikTok
          </Button>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标签</TableHead>
                  <TableHead className="text-right">广告户数</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-16 text-center text-sm text-muted-foreground">
                      尚无连接，点「连接 TikTok」开始首次授权
                    </TableCell>
                  </TableRow>
                ) : (
                  conns.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.advertiser_ids.length}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.expires_at ? new Date(c.expires_at).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(c.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive"
                          onClick={() => handleDeleteConn(c.id, c.label)}
                        >
                          <Unlink className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 授权账户表 */}
      <Card className="h-full">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            授权账户表
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              （已同步 {advertisers.length} 个广告户可选）
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

      {/* Connect dialog */}
      <Dialog open={connectOpen} onOpenChange={(o) => { if (!connecting) setConnectOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>连接 TikTok BC</DialogTitle>
            <DialogDescription>
              给本次授权起个标签（用于区分多个 BC），点确定会跳转到 TikTok 授权页。
              <br />
              <span className="text-xs">
                请先在 TikTok 开发者后台把 <code className="font-mono">{`${typeof window !== "undefined" ? window.location.origin : ""}/oauth/tiktok/callback`}</code> 加入 Advertiser Redirect URLs。
              </span>
            </DialogDescription>
          </DialogHeader>
          <Input
            value={connectLabel}
            onChange={(e) => setConnectLabel(e.target.value)}
            placeholder="例如 BC-主账号"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectOpen(false)} disabled={connecting}>取消</Button>
            <Button onClick={handleStartConnect} disabled={connecting}>
              {connecting ? "跳转中…" : "去授权"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
