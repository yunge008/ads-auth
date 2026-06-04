import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { invokeFn } from "@/lib/api";

export const Route = createFileRoute("/oauth/tiktok/callback")({
  head: () => ({
    meta: [{ title: "TikTok 授权回调" }],
  }),
  component: CallbackPage,
});

function CallbackPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  const [msg, setMsg] = useState("正在交换 access_token …");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const code = sp.get("auth_code") ?? sp.get("code");
    const st = sp.get("state") ?? "";
    if (!code) {
      setState("err");
      setMsg("URL 缺少 auth_code 参数");
      return;
    }
    (async () => {
      try {
        const data = await invokeFn<{ id: string; label: string; advertiser_ids: string[] }>(
          "tiktok-oauth-exchange",
          { auth_code: code, state: st },
        );
        sessionStorage.setItem("tt_connect_done", `${data.label}（${data.advertiser_ids.length} 个广告户）`);
        setState("ok");
        setMsg(`「${data.label}」连接成功，已获得 ${data.advertiser_ids.length} 个广告户的授权`);
        setTimeout(() => navigate({ to: "/settings" }), 1500);
      } catch (e) {
        setState("err");
        setMsg((e as Error).message);
      }
    })();
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {state === "loading" && <Loader2 className="h-5 w-5 animate-spin" />}
            {state === "ok" && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
            {state === "err" && <XCircle className="h-5 w-5 text-destructive" />}
            TikTok 授权回调
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{msg}</p>
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/settings" })}>
            返回设置
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
