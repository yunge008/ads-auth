import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { invokeFn } from "./api";
import type { AuthAccount, BCAdvertiser, Material, StaffSheet } from "./types";

const ACC_KEY = "tt_auth_accounts";
const STAFF_KEY = "tt_staff_sheets"; // legacy localStorage cache (migrated to supabase)
const BC_KEY = "tt_bc_advertisers";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

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

export function useStaff() {
  const [staff, setStaff] = useState<StaffSheet[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { staff: rows } = await invokeFn<{ staff: StaffSheet[] }>("staff-sheets", {
        action: "list",
      });
      setStaff(rows);
      if (typeof window !== "undefined") {
        localStorage.setItem(STAFF_KEY, JSON.stringify(rows));
      }
    } catch (e) {
      console.warn("load staff_sheets", (e as Error).message);
    }
  }, []);

  useEffect(() => {
    // Show cached value immediately, then fetch fresh from server.
    setStaff(read<StaffSheet[]>(STAFF_KEY, []));
    void refresh();
  }, [refresh]);

  const save = useCallback(async (next: StaffSheet[]) => {
    // Optimistic update
    setStaff(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(STAFF_KEY, JSON.stringify(next));
    }
    await invokeFn("staff-sheets", { action: "replace", staff: next });
    await refresh();
  }, [refresh]);

  return { staff, save };
}

export function useBCAdvertisers() {
  const [list, setList] = useState<BCAdvertiser[]>([]);
  useEffect(() => {
    setList(read<BCAdvertiser[]>(BC_KEY, []));
  }, []);
  const save = useCallback((next: BCAdvertiser[]) => {
    setList(next);
    localStorage.setItem(BC_KEY, JSON.stringify(next));
  }, []);
  return { advertisers: list, save };
}

export function loadAccounts(): AuthAccount[] {
  return read<AuthAccount[]>(ACC_KEY, []);
}
export function loadStaff(): StaffSheet[] {
  return read<StaffSheet[]>(STAFF_KEY, []);
}

// -------- Global materials store (persists across route changes) --------
let _materials: Material[] = [];
const _listeners = new Set<() => void>();
function emit() {
  for (const l of _listeners) l();
}

export const materialsStore = {
  get: () => _materials,
  set: (next: Material[] | ((prev: Material[]) => Material[])) => {
    _materials = typeof next === "function" ? (next as (p: Material[]) => Material[])(_materials) : next;
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
