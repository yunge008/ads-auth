// TikTok Shop（联盟达人外联）授权相关前端调用，全部走 Edge Function `tts-p0-probe`（仅管理员）。
import { invokeFn } from "@/lib/api";

export type TtsShop = {
  shop_id: string;
  shop_code: string | null;
  shop_name: string | null;
  region: string | null;
  seller_type: string | null;
  seller_name: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string[] | null;
  status: string;
  authorized_by: string | null;
  updated_at: string;
  app_code?: string | null;
  last_refresh_at?: string | null;
  last_refresh_error?: string | null;
};

/** 商家自用应用（每个店铺主体一个）。app_secret 只写不读。 */
export type TtsApp = {
  code: string;
  name: string;
  app_key: string;
  has_secret: boolean;
  service_id: string;
  creds_source: "table" | "secrets";
  updated_by: string | null;
  updated_at: string | null;
  shop_count: number;
};

export const TTS_DEFAULT_APP = "default";

/** 该应用在 Partner Center 填的重定向链接。default = 原应用沿用旧地址。 */
export function ttsRedirectUrl(
  code: string,
  origin = typeof window !== "undefined" ? window.location.origin : "https://ads-auth.lovable.app",
): string {
  return code === TTS_DEFAULT_APP
    ? `${origin}/oauth/tts/callback`
    : `${origin}/oauth/tts/callback/${code}`;
}

export type TtsExchangeResult = {
  saved: Array<{
    shop_id: string;
    shop_name: string | null;
    region: string | null;
    seller_type: string | null;
  }>;
  seller_name?: string;
  granted_scopes?: string[];
  get_authorized_shops?: { code: number | null; message: string };
};

/** 从「授权回调链接」或纯 code 中取出 code。 */
export function extractTtsCode(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return (u.searchParams.get("code") ?? u.searchParams.get("auth_code") ?? "").trim();
  } catch {
    const m = raw.match(/[?&](?:auth_)?code=([^&#\s]+)/);
    return m ? decodeURIComponent(m[1]) : raw;
  }
}

export const ttsApi = {
  apps: () => invokeFn<{ apps: TtsApp[] }>("tts-p0-probe", { action: "apps" }),
  saveApp: (app: {
    code: string;
    name?: string;
    app_key?: string;
    app_secret?: string;
    service_id?: string;
  }) => invokeFn<{ ok: boolean; apps: TtsApp[] }>("tts-p0-probe", { action: "save_app", ...app }),
  authUrl: (app = TTS_DEFAULT_APP) =>
    invokeFn<{ url: string }>("tts-p0-probe", { action: "auth_url", app }),
  shops: () => invokeFn<{ shops: TtsShop[] }>("tts-p0-probe", { action: "shops" }),
  exchange: (auth_code: string, app = TTS_DEFAULT_APP) =>
    invokeFn<TtsExchangeResult>("tts-p0-probe", { action: "exchange", auth_code, app }),
  refresh: (shop_id: string) =>
    invokeFn<TtsExchangeResult>("tts-p0-probe", { action: "refresh", shop_id }),
};
