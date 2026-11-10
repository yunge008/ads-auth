// TikTok Shop（联盟达人外联）授权回调：Partner Center 重定向地址 = https://ads-auth.lovable.app/oauth/tts/callback
// 页面在登录本工具后才会渲染（PasscodeGate），此时地址栏的 code 仍在，自动换 token 入库。
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { ttsApi, type TtsExchangeResult } from "@/lib/ttsApi";

export const Route = createFileRoute("/oauth/tts/callback")({
  head: () => ({ meta: [{ title: "TikTok Shop 授权回调" }] }),
  component: TtsCallbackPage,
});

function TtsCallbackPage() {
  const [stage, setStage] = useState<"loading" | "ok" | "err">("loading");
  const [msg, setMsg] = useState("正在完成店铺授权…");
  const [res, setRes] = useState<TtsExchangeResult | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // code 只能用一次，防止 StrictMode 重复调用
    started.current = true;
    const sp = new URLSearchParams(window.location.search);
    const code = sp.get("code") ?? sp.get("auth_code");
    if (!code || code === "null") {
      setStage("err");
      setMsg(sp.get("error") === "auth_denied" ? "卖家拒绝了授权" : "链接里没有 code 参数");
      return;
    }
    ttsApi
      .exchange(code)
      .then((r) => {
        setRes(r);
        if (r.saved?.length) {
          setStage("ok");
          setMsg(`已授权 ${r.saved.length} 个店铺`);
        } else {
          setStage("err");
          setMsg(`token 已拿到，但获取店铺列表失败：${r.get_authorized_shops?.message ?? "未知原因"}`);
        }
      })
      .catch((e) => {
        setStage("err");
        setMsg(`授权失败：${(e as Error).message}。code 30 分钟内有效且只能用一次，失败请重新打开授权链接。`);
      });
  }, []);

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {stage === "loading" && <Loader2 className="h-5 w-5 animate-spin" />}
          {stage === "ok" && <CheckCircle2 className="h-5 w-5 text-green-600" />}
          {stage === "err" && <XCircle className="h-5 w-5 text-red-600" />}
          TikTok Shop 店铺授权
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{msg}</p>
        {res?.saved?.length ? (
          <ul className="list-disc pl-5">
            {res.saved.map((s) => (
              <li key={s.shop_id}>
                {s.region} · {s.shop_name}（{s.seller_type}）<span className="font-mono text-xs ml-2">{s.shop_id}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {res?.granted_scopes && (
          <p className="text-muted-foreground">已授予权限：{res.granted_scopes.join("、")}</p>
        )}
        <Button asChild size="sm" variant="outline">
          <Link to="/settings">回到设置 → TikTok Shop 授权</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
