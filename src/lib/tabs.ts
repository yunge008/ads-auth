// Central registry of app tabs (UI nav + permission keys).
// To add a new tab: add an entry here (pick a `group`), create the route file,
// then admin assigns the tab key in the account permissions UI.
// `key` is the permission key stored in app_accounts.tab_permissions — never rename.
// `label` = full name (permissions UI, toasts); `navLabel` = short name shown
// inside its sidebar group.
import { Boxes, Database, FileDown, Flame, Handshake, Megaphone, MessageSquareText, PlusCircle, Settings, Store, Target, TerminalSquare, TrendingUp, Users, Zap, type LucideIcon } from "lucide-react";

export type NavGroupKey = "material" | "gmv-max" | "attribution" | "creator" | "shop";

export type NavGroup = { key: NavGroupKey; label: string; icon: LucideIcon };

export const NAV_GROUPS: NavGroup[] = [
  { key: "material", label: "素材授权", icon: Zap },
  { key: "gmv-max", label: "GMV Max", icon: Megaphone },
  { key: "attribution", label: "GMV 归因", icon: Target },
  { key: "creator", label: "达人管理", icon: Handshake },
  { key: "shop", label: "店铺", icon: Store },
];

export type TabDef = {
  key: string;
  label: string;
  navLabel?: string;
  to: string;
  icon: LucideIcon;
  group?: NavGroupKey;
  position?: "main" | "bottom";
};

export const TABS: TabDef[] = [
  { key: "home", label: "执行授权", to: "/", icon: Zap, group: "material" },
  // 评论内容暂时隐藏，相关 API 暂不支持
  // { key: "comments", label: "评论内容", to: "/comments", icon: MessageSquare },
  { key: "connection-stats", label: "发样及素材统计", to: "/connection-stats", icon: Users, group: "material" },
  { key: "material-performance", label: "素材成效", to: "/material-performance", icon: TrendingUp, group: "material" },
  { key: "gmv-max-create", label: "GMV MAX新建", navLabel: "新建广告组", to: "/gmv-max-create", icon: PlusCircle, group: "gmv-max" },
  { key: "feishu-data", label: "已获取数据查阅", navLabel: "数据查阅", to: "/feishu-data", icon: Database, group: "gmv-max" },
  { key: "gmv-attribution", label: "GMV 归因", navLabel: "归因结果", to: "/gmv-attribution", icon: Target, group: "attribution" },
  { key: "gmv-attribution-admin", label: "GMV 归因·管理", navLabel: "归因管理", to: "/gmv-attribution-admin", icon: Target, group: "attribution" },
  { key: "outreach", label: "达人建联", to: "/outreach", icon: Handshake, group: "creator" },
  { key: "creator-orders", label: "达人出单日报", navLabel: "达人出单", to: "/creator-orders", icon: Flame, group: "creator" },
  { key: "reviews", label: "评论查看", to: "/reviews", icon: MessageSquareText },
  { key: "tts-export", label: "店铺数据导出", navLabel: "数据导出", to: "/tts-export", icon: FileDown, group: "shop" },
  { key: "sea-inventory", label: "SEA库存监控", navLabel: "SEA 库存", to: "/sea-inventory", icon: Boxes, group: "shop" },
  { key: "settings", label: "设置", to: "/settings", icon: Settings, position: "bottom" },
  { key: "api-test", label: "API测试", to: "/api-test", icon: TerminalSquare, position: "bottom" },
];

export function tabByPath(path: string): TabDef | undefined {
  // longest-prefix match (so /settings/foo matches /settings)
  return [...TABS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((t) => (t.to === "/" ? path === "/" : path.startsWith(t.to)));
}

export type NavEntry =
  | { kind: "tab"; tab: TabDef }
  | { kind: "group"; group: NavGroup; tabs: TabDef[] };

/** Sidebar entries in TABS order; a group appears where its first tab is.
 *  A group with only one visible tab collapses to that tab (no header). */
export function buildNav(tabs: TabDef[]): NavEntry[] {
  const out: NavEntry[] = [];
  const seen = new Set<string>();
  for (const t of tabs) {
    if (!t.group) { out.push({ kind: "tab", tab: t }); continue; }
    if (seen.has(t.group)) continue;
    seen.add(t.group);
    const members = tabs.filter((x) => x.group === t.group);
    const group = NAV_GROUPS.find((g) => g.key === t.group)!;
    out.push(members.length === 1 ? { kind: "tab", tab: members[0] } : { kind: "group", group, tabs: members });
  }
  return out;
}
