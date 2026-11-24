import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { ChevronRight, LogOut, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { setPasscode } from "@/lib/api";
import { accountStore, useCurrentAccount, hasTab } from "@/lib/account";
import { TABS, buildNav, tabByPath, type NavGroupKey, type TabDef } from "@/lib/tabs";
import { toast } from "sonner";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const account = useCurrentAccount();

  const visibleTabs = useMemo(
    () =>
      account
        ? TABS.filter((t) => account.isAdmin || account.tabs.includes(t.key))
        : [],
    [account],
  );
  const mainNav = useMemo(() => buildNav(visibleTabs.filter((t) => t.position !== "bottom")), [visibleTabs]);
  const bottomTabs = visibleTabs.filter((t) => t.position === "bottom");
  const activeKey = tabByPath(location.pathname)?.key;
  const activeGroup = TABS.find((t) => t.key === activeKey)?.group;
  const [openGroups, setOpenGroups] = useState<Set<NavGroupKey>>(() => new Set());
  useEffect(() => setOpenGroups(loadOpenGroups()), []);
  const toggleGroup = (k: NavGroupKey) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      saveOpenGroups(next);
      return next;
    });

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

  return (
    <div className="flex h-screen bg-muted/30">
      <aside className="w-56 shrink-0 border-r bg-card flex flex-col h-screen sticky top-0">

        <div className="px-5 py-4 border-b flex items-start justify-between gap-2">
          <h1 className="text-base font-semibold text-foreground">AR广告工具</h1>
          <span className="text-[10px] text-muted-foreground font-mono pt-0.5 flex-none">v{APP_VERSION}</span>
        </div>
        <nav aria-label="主导航" className="flex-1 overflow-y-auto p-3 space-y-1">
          {mainNav.map((entry) => {
            if (entry.kind === "tab") {
              return <NavItem key={entry.tab.key} tab={entry.tab} active={activeKey === entry.tab.key} />;
            }
            const { group, tabs } = entry;
            // 当前页所在分组始终展开，避免选中项被折叠看不见
            const open = activeGroup === group.key || openGroups.has(group.key);
            const GroupIcon = group.icon;
            const containsActive = tabs.some((t) => t.key === activeKey);
            return (
              <div key={group.key}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`nav-group-${group.key}`}
                  onClick={() => toggleGroup(group.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-foreground",
                    containsActive ? "text-foreground font-medium" : "text-muted-foreground",
                  )}
                >
                  <GroupIcon className="h-4 w-4" />
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
                </button>
                {open && (
                  <div id={`nav-group-${group.key}`} role="group" aria-label={group.label} className="mt-0.5 ml-4 space-y-0.5 border-l pl-2">
                    {tabs.map((t) => (
                      <NavItem key={t.key} tab={t} active={activeKey === t.key} nested />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        {bottomTabs.length > 0 && (
          <nav aria-label="系统" className="p-3 border-t space-y-1">
            {bottomTabs.map((t) => (
              <NavItem key={t.key} tab={t} active={activeKey === t.key} />
            ))}
          </nav>
        )}
        <div className="p-3 border-t flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <User className="h-4 w-4 flex-none" />
            <span className="truncate">
              {account?.name}
              {account?.isAdmin && <span className="ml-1 text-primary">(管理员)</span>}
            </span>
          </div>
          <button
            type="button"
            aria-label="退出登录"
            title="退出登录"
            onClick={() => {
              setPasscode("");
              accountStore.set(null);
              toast.success("已退出登录");
              window.location.reload();
            }}
            className="flex-none rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

const NAV_OPEN_KEY = "nav.openGroups";

function loadOpenGroups(): Set<NavGroupKey> {
  try {
    const raw = localStorage.getItem(NAV_OPEN_KEY);
    if (raw) return new Set(JSON.parse(raw) as NavGroupKey[]);
  } catch { /* storage unavailable */ }
  return new Set();
}

function saveOpenGroups(s: Set<NavGroupKey>) {
  try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

function NavItem({ tab, active, nested }: { tab: TabDef; active: boolean; nested?: boolean }) {
  const Icon = tab.icon;
  const text = nested ? (tab.navLabel ?? tab.label) : tab.label;
  return (
    <Link
      to={tab.to}
      aria-current={active ? "page" : undefined}
      title={nested && text !== tab.label ? tab.label : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md text-sm transition-colors",
        nested ? "px-2.5 py-1.5" : "px-3 py-2",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {!nested && <Icon className="h-4 w-4" />}
      {text}
    </Link>
  );
}
