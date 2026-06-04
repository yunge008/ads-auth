import { useEffect, useState } from "react";
import { Link2, Unlink, Check, X, Pencil } from "lucide-react";
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  useBCAdvertisers,
  useConnections,
  refreshConnections,
  refreshBCAdvertisers,
} from "@/lib/store";
import { invokeFn } from "@/lib/api";

export function AccountsTable() {
  const { advertisers } = useBCAdvertisers();
  const { connections: conns, countries, setCountries } = useConnections();
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectLabel, setConnectLabel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [editingConnId, setEditingConnId] = useState<string | null>(null);
  const [editingConnLabel, setEditingConnLabel] = useState("");
  const [editingCountryAdv, setEditingCountryAdv] = useState<string | null>(null);
  const [editingCountryVal, setEditingCountryVal] = useState("");

  // Handle OAuth callback flag (new connection just added)
  useEffect(() => {
    const flag = sessionStorage.getItem("tt_connect_done");
    if (flag) {
      sessionStorage.removeItem("tt_connect_done");
      toast.success(`新增连接：${flag}`);
      refreshConnections().catch(() => {});
      refreshBCAdvertisers().catch(() => {});
    }
  }, []);


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
      window.open(data.authorize_url, "_blank", "noopener");
      setConnecting(false);
      setConnectOpen(false);
      toast.info("已在新标签页打开 TikTok 授权页，完成后回到本页面会自动刷新");
    } catch (e) {
      toast.error(`生成授权链接失败：${(e as Error).message}`);
      setConnecting(false);
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

  const handleSaveConnLabel = async (id: string) => {
    const label = editingConnLabel.trim();
    if (!label) {
      toast.error("标签不能为空");
      return;
    }
    try {
      await invokeFn("tiktok-connections", { op: "update", id, label });
      toast.success("已更新标签");
      setEditingConnId(null);
      loadConns();
    } catch (e) {
      toast.error(`更新失败：${(e as Error).message}`);
    }
  };

  const handleSaveCountry = async (advertiser_id: string) => {
    const country = editingCountryVal.trim();
    try {
      await invokeFn("tiktok-connections", { op: "set_country", advertiser_id, country });
      toast.success(country ? "已保存国家" : "已清空国家");
      setEditingCountryAdv(null);
      // Optimistic local update
      setCountries((prev) => {
        const next = { ...prev };
        if (country) next[advertiser_id] = country;
        else delete next[advertiser_id];
        return next;
      });
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    }
  };

  const advNameById = new Map(advertisers.map((a) => [a.advertiser_id, a.advertiser_name]));
  const flatRows = conns.flatMap((c) =>
    (c.advertiser_ids.length ? c.advertiser_ids : [""]).map((aid, idx) => ({
      conn_id: c.id,
      label: c.label,
      advertiser_id: aid,
      advertiser_name: aid ? (advNameById.get(aid) ?? aid) : "—",
      country: aid ? (countries[aid] ?? "") : "",
      created_at: c.created_at,
      is_first: idx === 0,
    })),
  );

  const totalAdvertisers = flatRows.filter((r) => r.advertiser_id).length;
  const taggedCount = flatRows.filter((r) => r.advertiser_id && r.country).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            TikTok 授权连接
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              （共 {conns.length} 个连接 · {totalAdvertisers} 个广告户 · 已标注国家 {taggedCount}）
            </span>
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleSyncBC} disabled={syncing}>
              <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
              同步广告户名称
            </Button>
            <Button size="sm" onClick={() => setConnectOpen(true)}>
              <Link2 className="h-4 w-4 mr-1" />
              连接 TikTok
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">标签</TableHead>
                  <TableHead>账户名</TableHead>
                  <TableHead className="w-44">账户ID</TableHead>
                  <TableHead className="w-32">国家</TableHead>
                  <TableHead className="w-40">授权时间</TableHead>
                  <TableHead className="w-16 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flatRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-16 text-center text-sm text-muted-foreground">
                      尚无连接，点「连接 TikTok」开始首次授权
                    </TableCell>
                  </TableRow>
                ) : (
                  flatRows.map((r, i) => (
                    <TableRow key={`${r.conn_id}-${r.advertiser_id || i}`}>
                      <TableCell className="font-medium">
                        {r.is_first ? (
                          editingConnId === r.conn_id ? (
                            <div className="flex items-center gap-1">
                              <Input
                                value={editingConnLabel}
                                onChange={(e) => setEditingConnLabel(e.target.value)}
                                className="h-7 w-24"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveConnLabel(r.conn_id);
                                  if (e.key === "Escape") setEditingConnId(null);
                                }}
                              />
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleSaveConnLabel(r.conn_id)}>
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditingConnId(null)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 hover:underline"
                              onClick={() => {
                                setEditingConnId(r.conn_id);
                                setEditingConnLabel(r.label);
                              }}
                            >
                              {r.label}
                              <Pencil className="h-3 w-3 text-muted-foreground" />
                            </button>
                          )
                        ) : null}
                      </TableCell>
                      <TableCell>{r.advertiser_name}</TableCell>
                      <TableCell className="font-mono text-xs">{r.advertiser_id || "—"}</TableCell>
                      <TableCell>
                        {!r.advertiser_id ? (
                          <span className="text-muted-foreground">—</span>
                        ) : editingCountryAdv === r.advertiser_id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              value={editingCountryVal}
                              onChange={(e) => setEditingCountryVal(e.target.value)}
                              placeholder="如 MX-AR"
                              className="h-7 w-20"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveCountry(r.advertiser_id);
                                if (e.key === "Escape") setEditingCountryAdv(null);
                              }}
                            />
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleSaveCountry(r.advertiser_id)}>
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditingCountryAdv(null)}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:underline"
                            onClick={() => {
                              setEditingCountryAdv(r.advertiser_id);
                              setEditingCountryVal(r.country);
                            }}
                          >
                            {r.country || <span className="text-muted-foreground">点击设置</span>}
                            <Pencil className="h-3 w-3 text-muted-foreground" />
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.is_first ? new Date(r.created_at).toLocaleString() : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.is_first && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive"
                            onClick={() => handleDeleteConn(r.conn_id, r.label)}
                          >
                            <Unlink className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

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
