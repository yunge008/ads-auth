import { Link, useRouter, useRouterState, useNavigate } from "@tanstack/react-router";
import { ChevronRight, LogOut, User } from "lucide-react";
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { setPasscode } from "@/lib/api";
import { accountStore, useCurrentAccount, hasTab } from "@/lib/account";
import { TABS, buildNav, tabByPath, type NavGroupKey, type TabDef } from "@/lib/tabs";
import { toast } from "sonner";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const router = useRouter();
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

  // ── 页面保活：访问过的 tab 页隐藏保留、不卸载，切回来不重新请求、已填内容不丢 ──
  const currentTab = tabByPath(location.pathname);
  const keepKey =
    account && currentTab && location.pathname === currentTab.to && hasTab(account, currentTab.key)
      ? currentTab.key
      : null;
  const [visited, setVisited] = useState<string[]>([]);
  const shown = keepKey && !visited.includes(keepKey) ? [...visited, keepKey] : visited;
  useEffect(() => {
    if (keepKey) setVisited((v) => (v.includes(keepKey) ? v : [...v, keepKey]));
  }, [keepKey]);

  // 每个页面各自记住滚动位置（共用 main 滚动容器）
  const mainRef = useRef<HTMLElement>(null);
  const scrollPos = useRef(new Map<string, number>());
  const prevKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    if (prevKey.current) scrollPos.current.set(prevKey.current, el.scrollTop);
    el.scrollTop = (keepKey && scrollPos.current.get(keepKey)) || 0;
    prevKey.current = keepKey;
  }, [keepKey]);

  // 登录后空闲时预加载全部可见页面代码，首次点击不再等下载
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const idle = () =>
      new Promise<void>((r) =>
        "requestIdleCallback" in window
          ? (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => r())
          : setTimeout(r, 50),
      );
    const timer = setTimeout(async () => {
      for (const t of visibleTabs) {
        if (cancelled) return;
        await idle();
        try {
          await router.preloadRoute({ to: t.to } as Parameters<typeof router.preloadRoute>[0]);
        } catch {
          /* 预加载失败不影响正常导航 */
        }
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [account, visibleTabs, router]);

  return (
    <div className="flex h-screen bg-muted/30">
      <aside className="w-56 shrink-0 border-r bg-card flex flex-col h-screen sticky top-0">

        <div className="px-5 py-4 border-b flex items-start justify-between gap-2">
          <h1 className="text-base font-semibold text-foreground">ARTPHRO</h1>
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
        <main ref={mainRef} className="flex-1 p-6 overflow-auto">
          {!keepKey && children}
          {shown.map((k) => {
            const tab = TABS.find((t) => t.key === k);
            const route = tab ? (router.routesByPath as unknown as Record<string, { options: { component?: ComponentType } }>)[tab.to] : undefined;
            const Page = route?.options.component;
            if (!Page) return null;
            return (
              <div key={k} hidden={k !== keepKey}>
                <PageErrorBoundary>
                  <Suspense fallback={<div className="text-sm text-muted-foreground">加载中…</div>}>
                    <Page />
                  </Suspense>
                </PageErrorBoundary>
              </div>
            );
          })}
        </main>
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

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-destructive">页面出错：{this.state.error.message}</p>
        <button type="button" className="underline" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    );
  }
}
