import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getPasscode, setPasscode, invokeFn } from "@/lib/api";
import { accountStore, type CurrentAccount } from "@/lib/account";
import { toast } from "sonner";

export function PasscodeGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [val, setVal] = useState("");
  const [checking, setChecking] = useState(true);

  const login = async () => {
    const { account } = await invokeFn<{ account: CurrentAccount }>(
      "app-accounts",
      { op: "me" },
    );
    accountStore.set(account);
    setUnlocked(true);
  };

  useEffect(() => {
    let cancelled = false;
    const code = getPasscode();
    if (!code) {
      setChecking(false);
      return;
    }
    login()
      .catch(() => {
        if (!cancelled) {
          setPasscode("");
          accountStore.set(null);
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    const onInvalid = () => {
      setUnlocked(false);
      setVal("");
      accountStore.set(null);
      toast.error("密码已失效，请重新输入");
    };
    window.addEventListener("tt-passcode-invalid", onInvalid);
    return () => {
      cancelled = true;
      window.removeEventListener("tt-passcode-invalid", onInvalid);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = val.trim();
    if (!v) return;
    setPasscode(v);
    setChecking(true);
    try {
      await login();
    } catch (err) {
      setPasscode("");
      accountStore.set(null);
      toast.error(`密码错误：${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        正在校验访问权限…
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
          <h1 className="text-base font-semibold">访问密码</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          本工具仅限内部使用，请输入访问密码后继续。
        </p>
        <Input
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="请输入访问密码"
          autoFocus
        />
        <Button type="submit" className="w-full" disabled={!val.trim()}>
          进入
        </Button>
      </form>
    </div>
  );
}
