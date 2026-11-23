// TikTok Shop 授权回调（商家自用应用）：Partner Center 重定向地址 = https://ads-auth.lovable.app/oauth/tts/callback/<app>
// <app> = tts_apps.code（如 mx-ar / mx-ne / mx-sj / jp），决定用哪组 app_key/app_secret 换 token。
import { createFileRoute } from "@tanstack/react-router";
import { TtsCallback } from "@/components/settings/TtsCallback";

export const Route = createFileRoute("/oauth/tts/callback_/$app")({
  head: () => ({ meta: [{ title: "TikTok Shop 授权回调" }] }),
  component: AppCallback,
});

function AppCallback() {
  const { app } = Route.useParams();
  return <TtsCallback app={app.toLowerCase()} />;
}
