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
  updated_by: string | null;
  updated_at: string | null;
  shop_count: number;
};

/** 该应用在 Partner Center 填的重定向链接（每个应用一条，末尾是应用代号；不设默认应用）。 */
/** 正式站点域名。Partner Center 只能填它（预览域名 lovableproject.com 不对外）。 */
export const TTS_REDIRECT_ORIGIN = "https://ads-auth.lovable.app";

export function ttsRedirectUrl(code: string): string {
  return `${TTS_REDIRECT_ORIGIN}/oauth/tts/callback/${code}`;
}

/** TikTok 回调地址里带的 app_key（用于核对应用没选错）。 */
export function extractTtsAppKey(input: string): string {
  const m = input.match(/[?&]app_key=([^&#\s]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** 回调 app_key 与所选应用不一致时返回错误文案；无法判断（没带 app_key / 应用没填）时返回 null。 */
export function ttsAppKeyMismatch(
  appKeyFromLink: string,
  app: string,
  apps: TtsApp[],
): string | null {
  const a = apps.find((x) => x.code === app);
  if (!appKeyFromLink || !a?.app_key || a.app_key === appKeyFromLink) return null;
  const right = apps.find((x) => x.app_key === appKeyFromLink);
  return (
    `回调里的 app_key（${appKeyFromLink}）不是应用 ${a.name} 的` +
    (right
      ? `，属于 ${right.name}：请检查 Partner Center 里 ${right.name} 的重定向链接`
      : "：请检查 Partner Center 应用的重定向链接")
  );
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
  authUrl: (app: string) => invokeFn<{ url: string }>("tts-p0-probe", { action: "auth_url", app }),
  shops: () => invokeFn<{ shops: TtsShop[] }>("tts-p0-probe", { action: "shops" }),
  exchange: (auth_code: string, app: string) =>
    invokeFn<TtsExchangeResult>("tts-p0-probe", { action: "exchange", auth_code, app }),
  refresh: (shop_id: string) =>
    invokeFn<TtsExchangeResult>("tts-p0-probe", { action: "refresh", shop_id }),
};
