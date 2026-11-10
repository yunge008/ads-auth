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
};

export type TtsExchangeResult = {
  saved: Array<{ shop_id: string; shop_name: string | null; region: string | null; seller_type: string | null }>;
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
  authUrl: () => invokeFn<{ url: string }>("tts-p0-probe", { action: "auth_url" }),
  shops: () => invokeFn<{ shops: TtsShop[] }>("tts-p0-probe", { action: "shops" }),
  exchange: (auth_code: string) => invokeFn<TtsExchangeResult>("tts-p0-probe", { action: "exchange", auth_code }),
  refresh: (shop_id: string) => invokeFn<TtsExchangeResult>("tts-p0-probe", { action: "refresh", shop_id }),
};
