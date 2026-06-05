import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { invokeFn } from "./api";
import type { AuthAccount, BCAdvertiser, Material, StaffSheet } from "./types";

const ACC_KEY = "tt_auth_accounts";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// ============== Generic module-level store ==============
function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T | ((prev: T) => T)) => {
      value =
        typeof v === "function"
          ? (v as (p: T) => T)(value)
          : v;
      for (const l of listeners) l();
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

// ============== Accounts (localStorage only) ==============
export function useAccounts() {
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  useEffect(() => {
    setAccounts(read<AuthAccount[]>(ACC_KEY, []));
  }, []);
  const save = useCallback((next: AuthAccount[]) => {
    setAccounts(next);
    localStorage.setItem(ACC_KEY, JSON.stringify(next));
  }, []);
  return { accounts, save };
}
export function loadAccounts(): AuthAccount[] {
  return read<AuthAccount[]>(ACC_KEY, []);
}

// ============== Staff (Supabase) ==============
const staffStore = createStore<StaffSheet[]>([]);
let staffLoaded = false;
export async function refreshStaff() {
  const { staff } = await invokeFn<{ staff: StaffSheet[] }>("staff-sheets", {
    action: "list",
  });
  staffStore.set(staff ?? []);
  staffLoaded = true;
}
export function useStaff() {
  const staff = useSyncExternalStore(
    staffStore.subscribe,
    staffStore.get,
    () => [] as StaffSheet[],
  );
  useEffect(() => {
    if (!staffLoaded) {
      refreshStaff().catch((e) => console.warn("load staff", (e as Error).message));
    }
  }, []);
  const save = useCallback(async (next: StaffSheet[]) => {
    staffStore.set(next);
    await invokeFn("staff-sheets", { action: "replace", staff: next });
    await refreshStaff();
  }, []);
  return { staff, save };
}
export function loadStaff(): StaffSheet[] {
  return staffStore.get();
}

// ============== BC Advertisers (TikTok BC API) ==============
const bcStore = createStore<BCAdvertiser[]>([]);
let bcLoaded = false;
export async function refreshBCAdvertisers(): Promise<{ count: number; warning?: string }> {
  const data = await invokeFn<{ advertisers: BCAdvertiser[]; warning?: string }>(
    "bc-list-advertisers",
  );
  const list = data?.advertisers ?? [];
  bcStore.set(list);
  bcLoaded = true;
  return { count: list.length, warning: data?.warning };
}
export function useBCAdvertisers() {
  const list = useSyncExternalStore(
    bcStore.subscribe,
    bcStore.get,
    () => [] as BCAdvertiser[],
  );
  useEffect(() => {
    if (!bcLoaded) {
      refreshBCAdvertisers().catch((e) =>
        console.warn("load BC advertisers", (e as Error).message),
      );
    }
  }, []);
  const save = useCallback((next: BCAdvertiser[]) => {
    bcStore.set(next);
  }, []);
  return { advertisers: list, save };
}

// ============== TikTok Connections (Supabase) ==============
export type Connection = {
  id: string;
  label: string;
  bc_id: string | null;
  advertiser_ids: string[];
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ShopInfo = { shop_id: string | null; shop_name: string | null };
type ConnectionsState = {
  connections: Connection[];
  countries: Record<string, string>;
  shops: Record<string, ShopInfo>;
};
const connStore = createStore<ConnectionsState>({ connections: [], countries: {}, shops: {} });
let connLoaded = false;
export async function refreshConnections() {
  const data = await invokeFn<{
    connections: Connection[];
    countries: Record<string, string>;
    shops?: Record<string, ShopInfo>;
  }>("tiktok-connections", { op: "list" });
  connStore.set({
    connections: data?.connections ?? [],
    countries: data?.countries ?? {},
    shops: data?.shops ?? {},
  });
  connLoaded = true;
}
export function useConnections() {
  const state = useSyncExternalStore(
    connStore.subscribe,
    connStore.get,
    () => ({ connections: [], countries: {}, shops: {} }) as ConnectionsState,
  );
  useEffect(() => {
    if (!connLoaded) {
      refreshConnections().catch((e) =>
        console.warn("load connections", (e as Error).message),
      );
    }
  }, []);
  const setCountries = useCallback(
    (updater: (prev: Record<string, string>) => Record<string, string>) => {
      connStore.set((prev) => ({ ...prev, countries: updater(prev.countries) }));
    },
    [],
  );
  const setShops = useCallback(
    (updater: (prev: Record<string, ShopInfo>) => Record<string, ShopInfo>) => {
      connStore.set((prev) => ({ ...prev, shops: updater(prev.shops) }));
    },
    [],
  );
  return { ...state, setCountries, setShops };
}

// ============== Global materials store ==============
let _materials: Material[] = [];
const _listeners = new Set<() => void>();
function emit() {
  for (const l of _listeners) l();
}

export const materialsStore = {
  get: () => _materials,
  set: (next: Material[] | ((prev: Material[]) => Material[])) => {
    _materials =
      typeof next === "function" ? (next as (p: Material[]) => Material[])(_materials) : next;
    emit();
  },
  subscribe: (cb: () => void) => {
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  },
};

export function useMaterials() {
  const materials = useSyncExternalStore(
    materialsStore.subscribe,
    materialsStore.get,
    () => [] as Material[],
  );
  return { materials, setMaterials: materialsStore.set };
}
