// Admin passcode gate + supabase admin client helper for edge functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export function checkAdminPasscode(_req: Request) {
  // Passcode gate removed — no-op.
  return;
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
