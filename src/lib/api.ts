import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const KEY = "tt_admin_passcode";
const _changeListeners = new Set<() => void>();
function emitChange() {
  for (const l of _changeListeners) l();
}

export function getPasscode(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(KEY) ?? "";
}
export function setPasscode(v: string) {
  localStorage.setItem(KEY, v);
  emitChange();
}
export function clearPasscode() {
  localStorage.removeItem(KEY);
  emitChange();
}

export function useHasPasscode(): boolean {
  const [has, setHas] = useState(() => !!getPasscode());
  useEffect(() => {
    const cb = () => setHas(!!getPasscode());
    _changeListeners.add(cb);
    return () => { _changeListeners.delete(cb); };
  }, []);
  return has;
}

const _listeners = new Set<() => void>();
export function onPasscodeNeeded(cb: () => void) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
function requestPasscode() {
  for (const l of _listeners) l();
}

export async function invokeFn<T = unknown>(
  name: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const passcode = getPasscode();
  if (!passcode) {
    requestPasscode();
    throw new Error("请先输入管理员密码");
  }
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body ?? {},
    headers: { "x-admin-passcode": passcode },
  });
  if (error) {
    // Try to extract error body — supabase wraps non-2xx into FunctionsHttpError
    const err = error as unknown as { context?: Response };
    let msg = error.message;
    if (err.context && typeof err.context.json === "function") {
      try {
        const j = await err.context.json();
        if (j?.error) msg = j.error;
      } catch { /* ignore */ }
    }
    if (msg.includes("密码")) {
      clearPasscode();
      requestPasscode();
    }
    throw new Error(msg);
  }
  return data as T;
}
