import { Link, useRouterState } from "@tanstack/react-router";
import { Settings, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { PasscodeGate } from "./PasscodeGate";
import { useHasPasscode } from "@/lib/api";
import { APP_VERSION } from "@/lib/version";

const nav = [
  { to: "/", label: "执行授权", icon: Zap },
  { to: "/settings", label: "设置", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const hasPasscode = useHasPasscode();

  // Before passcode is entered: blank screen with only the app title.
  if (!hasPasscode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          AR广告工具
        </h1>
        <PasscodeGate />
      </div>
    );
  }

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
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b bg-card flex items-center justify-end px-6">
          <span className="text-xs text-muted-foreground font-mono">
            v{APP_VERSION}
          </span>
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
      <PasscodeGate />
    </div>
  );
}
