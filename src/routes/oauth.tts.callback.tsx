// TikTok Shop 授权回调（原应用 default）：Partner Center 重定向地址 = https://ads-auth.lovable.app/oauth/tts/callback
// 商家自用应用走 /oauth/tts/callback/<app>（oauth.tts.callback_.$app.tsx）。
import { createFileRoute } from "@tanstack/react-router";
import { TtsCallback } from "@/components/settings/TtsCallback";

export const Route = createFileRoute("/oauth/tts/callback")({
  head: () => ({ meta: [{ title: "TikTok Shop 授权回调" }] }),
  component: () => <TtsCallback />,
});
