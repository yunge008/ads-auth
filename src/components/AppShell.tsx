import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, RefreshCw, Settings, Zap } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { setPasscode } from "@/lib/api";
import { refreshAllSettings } from "@/lib/store";
import { toast } from "sonner";

const nav = [
  { to: "/", label: "执行授权", icon: Zap },
  { to: "/settings", label: "设置", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const [syncing, setSyncing] = useState(false);

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
    <div className="flex min-h-screen bg-muted/30">
      <aside className="w-56 shrink-0 border-r bg-card flex flex-col">
        <div className="px-5 py-5 border-b">
          <h1 className="text-base font-semibold text-foreground">AR广告工具</h1>
          <p className="text-xs text-muted-foreground mt-0.5">广告户授权管理</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map((item) => {
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
        <div className="p-3 border-t">
          <button
            onClick={() => {
              setPasscode("");
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
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            同步表格信息
          </button>
          <span className="text-xs text-muted-foreground font-mono">
            v{APP_VERSION}
          </span>
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
