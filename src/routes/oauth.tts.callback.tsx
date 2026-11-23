// 旧授权回调地址（不带应用代号）。不设默认应用（2026-11-23）：这里不换 token，只提示改用 /oauth/tts/callback/<app>。
// 带应用的回调见 oauth.tts.callback_.$app.tsx。
import { createFileRoute } from "@tanstack/react-router";
import { TtsCallback } from "@/components/settings/TtsCallback";

export const Route = createFileRoute("/oauth/tts/callback")({
  head: () => ({ meta: [{ title: "TikTok Shop 授权回调" }] }),
  component: () => <TtsCallback />,
});
