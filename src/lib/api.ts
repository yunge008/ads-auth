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
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body ?? {},
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
    if (err.context && typeof err.context.json === "function") {
      try {
        const j = await err.context.json();
        if (j?.error) msg = j.error;
        status = err.context.status;
      } catch { /* ignore */ }
    }
    if (status === 401) {
      // Clear bad passcode so the gate re-prompts
      setPasscode("");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("tt-passcode-invalid"));
      }
    }
    throw new Error(msg);
  }
  return data as T;
}
