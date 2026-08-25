// Shared helpers for creating GMV Max campaigns (the closest TikTok equivalent
// of a GMV Max "ad group" — see gmv-max-adgroup-create/index.ts for context).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { ConnRow } from "./auth.ts";
import { ttPost } from "./tiktok.ts";

/** Numeric string request_id TikTok can parse as int64 (timestamp + random tail). */
export function genRequestId(salt = 0): string {
  return `${Date.now()}${String(salt).padStart(2, "0")}${Math.floor(Math.random() * 900 + 100)}`;
}

export async function findConnectionsForAdvertiser(
  db: SupabaseClient,
  advertiserId: string,
): Promise<Pick<ConnRow, "access_token" | "advertiser_ids" | "bc_id">[]> {
  const { data, error } = await db
    .from("tiktok_connections")
    .select("access_token, advertiser_ids, bc_id")
    .contains("advertiser_ids", [advertiserId]);
  if (error) throw new Error(error.message);
  return (data ?? []) as Pick<ConnRow, "access_token" | "advertiser_ids" | "bc_id">[];
}

/**
 * POST /campaign/gmv_max/create/ trying every stored authorization for the
 * advertiser in turn: some tokens may lack the GMV Max write scope (code
 * 40001) while another one has it.
 */
export async function createGmvMaxCampaign(
  conns: Pick<ConnRow, "access_token" | "advertiser_ids" | "bc_id">[],
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (conns.length === 0) throw new Error("该广告户没有可用的 TikTok 授权");
  let data: Record<string, unknown> | null = null;
  let lastErr: Error | null = null;
  for (const conn of conns) {
    try {
      data = await ttPost(conn.access_token, "/campaign/gmv_max/create/", body);
      break;
    } catch (e) {
      lastErr = e as Error;
      if (!/40001|permission/i.test(lastErr.message)) throw lastErr;
    }
  }
  if (!data) {
    throw new Error(
      `${lastErr?.message ?? "创建失败"}｜该广告户的授权缺少 GMV Max 建单（写）权限，请在 TikTok 商务中心重新授权并勾选广告管理写权限后重试`,
    );
  }
  return data;
}
