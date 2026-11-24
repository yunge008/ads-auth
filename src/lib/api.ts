import { supabase } from "@/integrations/supabase/client";

export const PASSCODE_KEY = "tt_admin_passcode";
export const NAME_KEY = "tt_admin_name";

export function getPasscode(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(PASSCODE_KEY) ?? "";
}

export function setPasscode(v: string) {
  if (typeof window === "undefined") return;
  if (v) window.localStorage.setItem(PASSCODE_KEY, v);
  else window.localStorage.removeItem(PASSCODE_KEY);
}

export function getAdminName(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(NAME_KEY) ?? "";
}

export function setAdminName(v: string) {
  if (typeof window === "undefined") return;
  if (v) window.localStorage.setItem(NAME_KEY, v);
  else window.localStorage.removeItem(NAME_KEY);
}

export async function invokeFn<T = unknown>(
  name: string,
  body?: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body ?? {},
    signal: options?.signal,
    timeout: options?.timeout,
    headers: {
      "x-admin-passcode": getPasscode(),
      // Header values must be ASCII; encode in case of CJK names.
      "x-admin-name": encodeURIComponent(getAdminName()),
    },
  });
  if (error) {
    const err = error as unknown as { context?: Response };
    let msg = error.message;
    let status: number | undefined;
    let payload: Record<string, unknown> | undefined;
    if (err.context && typeof err.context.text === "function") {
      status = err.context.status;
      try {
        const text = await err.context.text();
        try {
          const j = JSON.parse(text);
          payload = j;
          if (j?.error) msg = typeof j.error === "string" ? j.error : JSON.stringify(j.error);
          // 平台层错误（超时 / WORKER_LIMIT / BOOT_ERROR）没有 error 字段，带上状态码和 code/message 便于定位
          else msg = `HTTP ${status} ${[j?.code, j?.message ?? j?.msg].filter(Boolean).join(" ") || text.slice(0, 200)}`;
        } catch {
          msg = `HTTP ${status} ${text.slice(0, 200) || error.message}`;
        }
      } catch {
        msg = `HTTP ${status} ${error.message}`;
      }
    }
    if (status === 401) {
      // Clear bad passcode so the gate re-prompts
      setPasscode("");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("tt-passcode-invalid"));
      }
    }
    const outErr = new Error(msg) as Error & { payload?: Record<string, unknown> };
    if (payload) outErr.payload = payload;
    throw outErr;
  }
  return data as T;
}

/** 调 Lovable 服务端路由 /api/public/hooks/eco（ECO 代理商后台操作；Supabase 出口被 ECO 拦截，只能走这里） */
export async function callEcoRoute<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/public/hooks/eco", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-passcode": getPasscode(),
      "x-admin-name": encodeURIComponent(getAdminName()),
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

/** 调 GMV Max 写操作服务端路由（建组 / 独占授权；不走 Edge Function，免部署积分） */
export async function callGmvMaxWrite<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/public/hooks/gmv-max-write", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-passcode": getPasscode(),
      "x-admin-name": encodeURIComponent(getAdminName()),
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
  return j;
}
