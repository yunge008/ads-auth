import { useEffect, useState, useCallback } from "react";
import type { AuthAccount, StaffSheet } from "./types";

const ACC_KEY = "tt_auth_accounts";
const STAFF_KEY = "tt_staff_sheets";

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
  useEffect(() => {
    setStaff(read<StaffSheet[]>(STAFF_KEY, []));
  }, []);
  const save = useCallback((next: StaffSheet[]) => {
    setStaff(next);
    localStorage.setItem(STAFF_KEY, JSON.stringify(next));
  }, []);
  return { staff, save };
}

export function loadAccounts(): AuthAccount[] {
  return read<AuthAccount[]>(ACC_KEY, []);
}
export function loadStaff(): StaffSheet[] {
  return read<StaffSheet[]>(STAFF_KEY, []);
}
