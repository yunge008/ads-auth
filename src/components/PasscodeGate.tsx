import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getPasscode,
  setPasscode,
  getAdminName,
  setAdminName,
  invokeFn,
} from "@/lib/api";
import { accountStore, type CurrentAccount } from "@/lib/account";
import { toast } from "sonner";

export function PasscodeGate({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [name, setName] = useState("");
  const [val, setVal] = useState("");
  const [checking, setChecking] = useState(false);

  // Transient gateway/network hiccups (503 / 504 IDLE_TIMEOUT / offline) must
  // not log the user out — retry a few times before giving up.
  const isTransient = (e: unknown) => {
    const m = String((e as Error)?.message ?? "");
    return /50[234]|IDLE_TIMEOUT|DEGRADED|timeout|Failed to fetch|NetworkError|network/i.test(m);
  };

  const login = async () => {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const { account } = await invokeFn<{ account: CurrentAccount }>(
          "app-accounts",
          { op: "me" },
          { timeout: 20000 },
        );
        accountStore.set(account);
        setUnlocked(true);
        return;
      } catch (e) {
        lastErr = e;
        if (!isTransient(e)) break;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
      }
    }
    throw lastErr;
  };

  useEffect(() => {
    setMounted(true);
    let cancelled = false;
    const code = getPasscode();
    if (code) {
      setChecking(true);
      login()
        .catch((e) => {
          if (cancelled) return;
          if (isTransient(e)) {
            // Keep credentials;服务暂时不可用时只提示，不强制退出登录。
            toast.error("服务暂时不可用，请稍后重试登录");
            return;
          }
          setPasscode("");
          setAdminName("");
          accountStore.set(null);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }

    const onInvalid = () => {
      setUnlocked(false);
      setVal("");
      accountStore.set(null);
      toast.error("登录已失效，请重新输入");
    };
    window.addEventListener("tt-passcode-invalid", onInvalid);
    return () => {
      cancelled = true;
      window.removeEventListener("tt-passcode-invalid", onInvalid);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const v = val.trim();
    if (!n || !v) return;
    setAdminName(n);
    setPasscode(v);
    setChecking(true);
    try {
      await login();
    } catch (err) {
      setPasscode("");
      setAdminName("");
      accountStore.set(null);
      toast.error(`登录失败：${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  if (!mounted || checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        {checking ? "正在校验访问权限…" : ""}
      </div>
    );
  }

  if (unlocked) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">登录</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          本工具仅限内部使用，请输入用户名与密码后继续。
        </p>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">用户名</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="请输入用户名"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">密码</label>
          <Input
            type="password"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="请输入密码"
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={!name.trim() || !val.trim()}
        >
          进入
        </Button>
      </form>
    </div>
  );
}
