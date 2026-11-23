// 设置 → TikTok Shop 授权（Shop Open API；与上面「授权」页的广告 BC 授权无关）。
// 多应用（2026-11-23）：每个店铺主体一个「商家自用」应用，各自 App Key / Secret / Service ID / 重定向链接。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Copy, ExternalLink, HelpCircle, Pencil, Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import {
  extractTtsCode,
  TTS_DEFAULT_APP,
  ttsApi,
  type TtsApp,
  ttsRedirectUrl,
  type TtsShop,
} from "@/lib/ttsApi";

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
const appLabel = (code: string | null | undefined, apps: TtsApp[]) => {
  const c = code ?? TTS_DEFAULT_APP;
  return (
    apps.find((a) => a.code === c)?.name ?? (c === TTS_DEFAULT_APP ? "原应用" : c.toUpperCase())
  );
};

/** 「?」说明：悬停 / 键盘聚焦 / 点按都能打开。 */
function Help({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 text-xs space-y-1.5">{children}</PopoverContent>
    </Popover>
  );
}

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${what}已复制`);
}

type Draft = {
  code: string;
  name: string;
  app_key: string;
  app_secret: string;
  service_id: string;
  isNew: boolean;
};

function AppDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft | null;
  onClose: () => void;
  onSaved: (apps: TtsApp[]) => void;
}) {
  const [d, setD] = React.useState<Draft | null>(draft);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setD(draft), [draft]);
  if (!d) return null;
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setD({ ...d, [k]: e.target.value });
  const codeOk = /^[a-z0-9-]{1,32}$/.test(d.code);
  const save = async () => {
    setSaving(true);
    try {
      const r = await ttsApi.saveApp({
        code: d.code,
        name: d.name.trim() || d.code.toUpperCase(),
        app_key: d.app_key,
        app_secret: d.app_secret,
        service_id: d.service_id,
      });
      toast.success(`应用 ${d.code} 已保存`);
      onSaved(r.apps);
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{d.isNew ? "新增应用" : `编辑应用 ${d.code}`}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid gap-1">
            <Label htmlFor="tts-app-code">代号</Label>
            <Input
              id="tts-app-code"
              value={d.code}
              disabled={!d.isNew}
              placeholder="mx-ar"
              onChange={(e) => setD({ ...d, code: e.target.value.trim().toLowerCase() })}
            />
            {d.code && (
              <span className="font-mono text-xs text-muted-foreground break-all">
                {ttsRedirectUrl(d.code)}
              </span>
            )}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="tts-app-name">名称</Label>
            <Input id="tts-app-name" value={d.name} onChange={set("name")} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="tts-app-key">App Key</Label>
            <Input
              id="tts-app-key"
              value={d.app_key}
              onChange={set("app_key")}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="tts-app-secret">App Secret</Label>
            <Input
              id="tts-app-secret"
              type="password"
              value={d.app_secret}
              onChange={set("app_secret")}
              autoComplete="new-password"
              placeholder={d.isNew ? "" : "留空 = 不修改"}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="tts-app-sid">Service ID</Label>
            <Input
              id="tts-app-sid"
              value={d.service_id}
              onChange={set("service_id")}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={saving || !codeOk}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TtsShopsPanel() {
  const [shops, setShops] = React.useState<TtsShop[]>([]);
  const [apps, setApps] = React.useState<TtsApp[]>([]);
  const [appsErr, setAppsErr] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [paste, setPaste] = React.useState("");
  const [pasteApp, setPasteApp] = React.useState(TTS_DEFAULT_APP);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const [s, a] = await Promise.allSettled([ttsApi.shops(), ttsApi.apps()]);
      if (s.status === "fulfilled") setShops(s.value.shops ?? []);
      else toast.error(`加载店铺失败：${(s.reason as Error).message}`);
      if (a.status === "fulfilled") {
        setApps(a.value.apps ?? []);
        setAppsErr("");
      } else setAppsErr((a.reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const openAuth = async (code: string, mode: "open" | "copy") => {
    setBusy(`auth:${code}`);
    try {
      const { url } = await ttsApi.authUrl(code);
      if (mode === "copy") await copy(url, "授权链接");
      else window.open(url, "_blank", "noreferrer");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exchange = async () => {
    const code = extractTtsCode(paste);
    if (!code) {
      toast.error("请粘贴授权后跳转的完整链接，或其中 code= 后面那串");
      return;
    }
    // 粘贴的是带 /oauth/tts/callback/<app> 的完整链接时，以链接里的应用为准
    const m = paste.match(/\/oauth\/tts\/callback\/([a-z0-9-]+)/i);
    const app = m ? m[1].toLowerCase() : pasteApp;
    setBusy("exchange");
    try {
      const r = await ttsApi.exchange(code, app);
      if (!r.saved?.length) {
        toast.error(`授权成功但没拿到店铺：${r.get_authorized_shops?.message ?? "未知原因"}`);
      } else {
        toast.success(
          `已授权 ${r.saved.length} 个店铺：${r.saved.map((s) => `${s.region} ${s.shop_name}`).join("、")}`,
        );
      }
      setPaste("");
      await reload();
    } catch (e) {
      toast.error(`换取失败：${(e as Error).message}（code 只能用一次、30 分钟内有效）`);
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (shopId: string) => {
    setBusy(shopId);
    try {
      await ttsApi.refresh(shopId);
      toast.success("token 已刷新");
      await reload();
    } catch (e) {
      toast.error(`刷新失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const editApp = (a: TtsApp) =>
    setDraft({
      code: a.code,
      name: a.name,
      app_key: a.creds_source === "secrets" ? "" : a.app_key,
      app_secret: "",
      service_id: a.service_id,
      isNew: false,
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-1">
            应用
            <Help label="应用与授权说明">
              <div>
                每个店铺主体在 Partner Center 开一个「商家自用」应用，把 App Key / App Secret /
                Service ID 填到这里。
              </div>
              <div>
                「重定向链接」原样填到该应用的 Redirect URL；授权回来时按链接末尾的代号选应用换
                token，填错会换取失败。
              </div>
              <div>
                授权：点「授权」→ 在已登录该店铺卖家账号的浏览器里同意 → 跳回本工具自动完成。code 30
                分钟内有效、只能用一次。
              </div>
              <div>
                原应用（default）的 App Key / Secret 为空时读 Supabase secrets TTS_APP_KEY /
                TTS_APP_SECRET / TTS_SERVICE_ID。
              </div>
              <div>token 每天北京 05:17 自动刷新 48 小时内到期的授权，失败发飞书。</div>
            </Help>
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDraft({
                code: "",
                name: "",
                app_key: "",
                app_secret: "",
                service_id: "",
                isNew: true,
              })
            }
          >
            <Plus className="h-4 w-4 mr-1" />
            新增
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {appsErr && <p className="text-amber-600">{appsErr}</p>}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>应用</TableHead>
                  <TableHead>App Key</TableHead>
                  <TableHead>Secret</TableHead>
                  <TableHead>Service ID</TableHead>
                  <TableHead>重定向链接</TableHead>
                  <TableHead>店铺</TableHead>
                  <TableHead>
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map((a) => {
                  const ready = !!a.app_key && a.has_secret;
                  const redirect = ttsRedirectUrl(a.code);
                  return (
                    <TableRow key={a.code}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{a.code}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {a.app_key || <span className="text-amber-600">—</span>}
                      </TableCell>
                      <TableCell>
                        {a.has_secret ? "✓" : <span className="text-amber-600">—</span>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {a.service_id || <span className="text-amber-600">—</span>}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-mono text-xs hover:underline text-left break-all"
                          onClick={() => copy(redirect, "重定向链接")}
                          aria-label={`复制 ${a.name} 重定向链接`}
                        >
                          {redirect}
                          <Copy className="h-3 w-3 shrink-0" />
                        </button>
                      </TableCell>
                      <TableCell>{a.shop_count}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => editApp(a)}
                          aria-label={`编辑 ${a.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          disabled={!ready || !a.service_id || busy === `auth:${a.code}`}
                          onClick={() => openAuth(a.code, "open")}
                        >
                          <ExternalLink className="h-4 w-4 mr-1" />
                          授权
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!ready || !a.service_id}
                          onClick={() => openAuth(a.code, "copy")}
                          aria-label={`复制 ${a.name} 授权链接`}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={pasteApp} onValueChange={setPasteApp}>
              <SelectTrigger className="w-36" aria-label="授权所属应用">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(apps.length ? apps : [{ code: TTS_DEFAULT_APP, name: "原应用" } as TtsApp]).map(
                  (a) => (
                    <SelectItem key={a.code} value={a.code}>
                      {a.name}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <Input
              className="flex-1 min-w-[16rem]"
              aria-label="授权跳转链接或 code"
              placeholder="授权跳转后的完整链接或 code"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <Button size="sm" onClick={exchange} disabled={busy === "exchange"}>
              {busy === "exchange" ? "处理中…" : "完成授权"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">已授权店铺（{shops.length}）</CardTitle>
          <Button size="sm" variant="outline" onClick={reload} disabled={loading}>
            <RotateCw className="h-4 w-4 mr-1" />
            刷新列表
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>应用</TableHead>
                <TableHead>站点</TableHead>
                <TableHead>店铺名</TableHead>
                <TableHead>店铺ID</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>access 到期</TableHead>
                <TableHead>授权到期</TableHead>
                <TableHead>上次刷新</TableHead>
                <TableHead>权限数</TableHead>
                <TableHead>授权人</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shops.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground">
                    {loading ? "加载中…" : "还没有授权店铺"}
                  </TableCell>
                </TableRow>
              )}
              {shops.map((s) => (
                <TableRow key={s.shop_id}>
                  <TableCell>{appLabel(s.app_code, apps)}</TableCell>
                  <TableCell>{s.region}</TableCell>
                  <TableCell>{s.shop_name}</TableCell>
                  <TableCell className="font-mono text-xs">{s.shop_id}</TableCell>
                  <TableCell>{s.seller_type}</TableCell>
                  <TableCell>{fmt(s.access_expires_at)}</TableCell>
                  <TableCell>{fmt(s.refresh_expires_at)}</TableCell>
                  <TableCell
                    className={s.last_refresh_error ? "text-red-600" : ""}
                    title={s.last_refresh_error ?? undefined}
                  >
                    {fmt(s.last_refresh_at)}
                    {s.last_refresh_error ? " ✗" : ""}
                  </TableCell>
                  <TableCell title={(s.scopes ?? []).join("\n")}>{s.scopes?.length ?? 0}</TableCell>
                  <TableCell>{s.authorized_by}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => refresh(s.shop_id)}
                      disabled={busy === s.shop_id}
                    >
                      刷新 token
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {draft && (
        <AppDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={(a) => {
            setApps(a);
            setDraft(null);
          }}
        />
      )}
    </div>
  );
}
