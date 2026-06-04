// Current account store (set on login, cleared on logout).
import { useSyncExternalStore } from "react";

export type CurrentAccount = {
  id: string;
  name: string;
  isAdmin: boolean;
  tabs: string[];
};

const KEY = "tt_current_account";

function read(): CurrentAccount | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CurrentAccount) : null;
  } catch {
    return null;
  }
}

let value: CurrentAccount | null = read();
const listeners = new Set<() => void>();

export const accountStore = {
  get: () => value,
  set: (v: CurrentAccount | null) => {
    value = v;
    if (typeof window !== "undefined") {
      if (v) window.localStorage.setItem(KEY, JSON.stringify(v));
      else window.localStorage.removeItem(KEY);
    }
    for (const l of listeners) l();
  },
  subscribe: (cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

export function useCurrentAccount(): CurrentAccount | null {
  return useSyncExternalStore(accountStore.subscribe, accountStore.get, () => null);
}

export function hasTab(account: CurrentAccount | null, tab: string): boolean {
  if (!account) return false;
  return account.isAdmin || account.tabs.includes(tab);
}
