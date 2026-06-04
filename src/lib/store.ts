import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
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
    const { data, error } = await supabase
      .from("staff_sheets")
      .select("id,name,sheet_name,active,sort_order")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      console.warn("load staff_sheets", error.message);
      return;
    }
    const rows: StaffSheet[] = (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      sheet_name: r.sheet_name,
      active: r.active,
    }));
    setStaff(rows);
    if (typeof window !== "undefined") {
      localStorage.setItem(STAFF_KEY, JSON.stringify(rows));
    }
  }, []);

  useEffect(() => {
    // Show cached value immediately, then fetch fresh from Supabase.
    setStaff(read<StaffSheet[]>(STAFF_KEY, []));
    void refresh();
  }, [refresh]);

  const save = useCallback(async (next: StaffSheet[]) => {
    // Optimistic update
    setStaff(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(STAFF_KEY, JSON.stringify(next));
    }
    // Replace-all semantics to match the UI's edit model.
    const { error: delErr } = await supabase
      .from("staff_sheets")
      .delete()
      .not("id", "is", null);
    if (delErr) {
      console.error("staff delete", delErr);
      throw new Error(delErr.message);
    }
    if (next.length > 0) {
      const payload = next.map((r, i) => ({
        id: r.id,
        name: r.name,
        sheet_name: r.sheet_name,
        active: r.active,
        sort_order: i,
      }));
      const { error: insErr } = await supabase.from("staff_sheets").insert(payload);
      if (insErr) {
        console.error("staff insert", insErr);
        throw new Error(insErr.message);
      }
    }
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
