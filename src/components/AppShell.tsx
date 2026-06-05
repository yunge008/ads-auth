import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { LogOut, RefreshCw, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { setPasscode } from "@/lib/api";
import { refreshAllSettings } from "@/lib/store";
import { accountStore, useCurrentAccount, hasTab } from "@/lib/account";
import { TABS, tabByPath } from "@/lib/tabs";
import { toast } from "sonner";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const account = useCurrentAccount();
  const [syncing, setSyncing] = useState(false);

  const visibleTabs = useMemo(
    () =>
      account
        ? TABS.filter((t) => account.isAdmin || account.tabs.includes(t.key))
        : [],
    [account],
  );

  // Route guard: kick the user to their first allowed tab if they hit a
  // restricted path directly.
  useEffect(() => {
    if (!account) return;
    const current = tabByPath(location.pathname);
    if (current && !hasTab(account, current.key)) {
      const target = visibleTabs[0]?.to ?? "/";
      toast.error(`无权限访问 ${current.label}`);
      navigate({ to: target });
    }
  }, [account, location.pathname, visibleTabs, navigate]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await refreshAllSettings();
      toast.success("已同步表格信息");
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex h-screen bg-muted/30">
      <aside className="w-56 shrink-0 border-r bg-card flex flex-col h-screen sticky top-0">

        <div className="px-5 py-5 border-b">
          <h1 className="text-base font-semibold text-foreground">AR广告工具</h1>
          <p className="text-xs text-muted-foreground mt-0.5">广告户授权管理</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {visibleTabs.map((item) => {
            const active =
              item.to === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        {account && (
          <div className="px-3 py-2 border-t flex items-center gap-2 text-xs text-muted-foreground">
            <User className="h-3.5 w-3.5" />
            <span className="truncate">
              {account.name}
              {account.isAdmin && (
                <span className="ml-1 text-primary">(管理员)</span>
              )}
            </span>
          </div>
        )}
        <div className="p-3 border-t">
          <button
            onClick={() => {
              setPasscode("");
              accountStore.set(null);
              toast.success("已退出登录");
              window.location.reload();
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b bg-card flex items-center justify-end gap-3 px-6">
          {account?.isAdmin && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
              同步表格信息
            </button>
          )}
          <span className="text-xs text-muted-foreground font-mono">
            v{APP_VERSION}
          </span>
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
