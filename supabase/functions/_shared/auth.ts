// Admin passcode gate + supabase admin client helper for edge functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type AppAccount = {
  id: string;
  name: string;
  isAdmin: boolean;
  tabs: string[];
};

const ROOT_ACCOUNT: AppAccount = {
  id: "root",
  name: "Root",
  isAdmin: true,
  tabs: [],
};

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function unauthorized(msg = "未授权：请输入正确的访问密码"): Error & { status: number } {
  const err = new Error(msg) as Error & { status: number };
  err.status = 401;
  return err;
}
function forbidden(msg = "无权限访问该功能"): Error & { status: number } {
  const err = new Error(msg) as Error & { status: number };
  err.status = 403;
  return err;
}

/**
 * Verify passcode header and return the account it belongs to.
 * - Env ADMIN_PASSCODE always works and is treated as root admin.
 * - Otherwise look up sha256(passcode) in app_accounts.
 * - If requiredTab is supplied, non-admins must have the tab in tab_permissions.
 */
export async function verifyPasscode(
  req: Request,
  requiredTab?: string,
): Promise<AppAccount> {
  const got = (req.headers.get("x-admin-passcode") ?? "").trim();
  if (!got) throw unauthorized();

  // Root env passcode (always admin; survives empty DB)
  const envCode = Deno.env.get("ADMIN_PASSCODE");
  if (envCode && got === envCode) return { ...ROOT_ACCOUNT };

  const hash = await sha256Hex(got);
  const db = admin();
  const { data, error } = await db
    .from("app_accounts")
    .select("id,name,is_admin,tab_permissions,active")
    .eq("passcode_hash", hash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw unauthorized();
  if (!data.active) throw forbidden("账号已停用");

  const acc: AppAccount = {
    id: data.id,
    name: data.name,
    isAdmin: !!data.is_admin,
    tabs: Array.isArray(data.tab_permissions) ? data.tab_permissions : [],
  };

  if (requiredTab && !acc.isAdmin && !acc.tabs.includes(requiredTab)) {
    throw forbidden(`无权限访问 ${requiredTab}`);
  }
  return acc;
}

/** Backward-compat: pass-through verify, throws on failure. */
export async function checkAdminPasscode(req: Request, requiredTab?: string) {
  await verifyPasscode(req, requiredTab);
}

export async function requireAdmin(req: Request): Promise<AppAccount> {
  const acc = await verifyPasscode(req);
  if (!acc.isAdmin) throw forbidden("仅管理员可执行该操作");
  return acc;
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
