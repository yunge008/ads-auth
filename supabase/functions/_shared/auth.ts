// Admin passcode gate + supabase admin client helper for edge functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export function checkAdminPasscode(req: Request) {
  const expected = Deno.env.get("ADMIN_PASSCODE");
  if (!expected) throw new Error("ADMIN_PASSCODE 未配置");
  const got = req.headers.get("x-admin-passcode") ?? "";
  if (got !== expected) {
    const err = new Error("管理员密码错误或缺失");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
}

let _admin: SupabaseClient | null = null;
export function admin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

export type ConnRow = {
  id: string;
  label: string;
  access_token: string;
  bc_id: string | null;
  advertiser_ids: string[];
  expires_at: string | null;
  updated_at: string;
  created_at: string;
};
