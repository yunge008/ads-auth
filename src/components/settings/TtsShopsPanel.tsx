// 设置 → TikTok Shop 授权（联盟达人外联用，Shop Open API；与上面「授权」页的广告 BC 授权无关）。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Copy, ExternalLink, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { extractTtsCode, ttsApi, type TtsShop } from "@/lib/ttsApi";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

export function TtsShopsPanel() {
  const [shops, setShops] = React.useState<TtsShop[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [authUrl, setAuthUrl] = React.useState("");
  const [authUrlErr, setAuthUrlErr] = React.useState("");
  const [paste, setPaste] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const { shops } = await ttsApi.shops();
      setShops(shops ?? []);
    } catch (e) {
      toast.error(`加载店铺失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    reload();
    ttsApi.authUrl().then((r) => setAuthUrl(r.url)).catch((e) => setAuthUrlErr((e as Error).message));
  }, [reload]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(authUrl);
    toast.success("授权链接已复制，可粘贴到指纹浏览器打开");
  };

  const exchange = async () => {
    const code = extractTtsCode(paste);
    if (!code) { toast.error("请粘贴授权后跳转的完整链接，或其中 code= 后面那串"); return; }
    setBusy("exchange");
    try {
      const r = await ttsApi.exchange(code);
      if (!r.saved?.length) {
        toast.error(`授权成功但没拿到店铺：${r.get_authorized_shops?.message ?? "未知原因"}`);
      } else {
        toast.success(`已授权 ${r.saved.length} 个店铺：${r.saved.map((s) => `${s.region} ${s.shop_name}`).join("、")}`);
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">授权 TikTok Shop 店铺（联盟达人外联）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>点「打开授权链接」（或复制后粘贴到已登录该店铺卖家账号的指纹浏览器）。</li>
            <li>在 TikTok Shop 页面登录卖家账号 → 同意授权。跨境卖家一次授权会带出 PH、TH 等多个站点店铺。</li>
            <li>授权后会跳到本工具的「授权回调」页，登录本工具后自动完成；若没自动完成，把跳转后的完整链接粘贴到下面的框里点「完成授权」。<b>30 分钟内有效、只能用一次</b>。</li>
          </ol>
          {authUrl ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <a href={authUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4 mr-1" />打开授权链接</a>
              </Button>
              <Button size="sm" variant="outline" onClick={copyLink}><Copy className="h-4 w-4 mr-1" />复制授权链接</Button>
            </div>
          ) : (
            <p className="text-amber-600">
              {authUrlErr || "正在获取授权链接…"}
            </p>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="粘贴授权后跳转的完整链接（https://ads-auth.lovable.app/oauth/tts/callback?code=…）或 code"
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
            <RotateCw className="h-4 w-4 mr-1" />刷新列表
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>站点</TableHead>
                <TableHead>店铺名</TableHead>
                <TableHead>店铺ID</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>access 到期</TableHead>
                <TableHead>授权到期</TableHead>
                <TableHead>权限数</TableHead>
                <TableHead>授权人</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shops.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    {loading ? "加载中…" : "还没有授权店铺"}
                  </TableCell>
                </TableRow>
              )}
              {shops.map((s) => (
                <TableRow key={s.shop_id}>
                  <TableCell>{s.region}</TableCell>
                  <TableCell>{s.shop_name}</TableCell>
                  <TableCell className="font-mono text-xs">{s.shop_id}</TableCell>
                  <TableCell>{s.seller_type}</TableCell>
                  <TableCell>{fmt(s.access_expires_at)}</TableCell>
                  <TableCell>{fmt(s.refresh_expires_at)}</TableCell>
                  <TableCell title={(s.scopes ?? []).join("\n")}>{s.scopes?.length ?? 0}</TableCell>
                  <TableCell>{s.authorized_by}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => refresh(s.shop_id)} disabled={busy === s.shop_id}>
                      刷新 token
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
