// Central registry of app tabs (UI nav + permission keys).
// To add a new tab: add an entry here, create the route file, then admin
// assigns the tab key in the account permissions UI.
import { Database, MessageSquare, Settings, TerminalSquare, TrendingUp, Zap, type LucideIcon } from "lucide-react";

export type TabDef = {
  key: string;
  label: string;
  to: string;
  icon: LucideIcon;
  position?: "main" | "bottom";
};

export const TABS: TabDef[] = [
  { key: "home", label: "执行授权", to: "/", icon: Zap },
  { key: "comments", label: "评论内容", to: "/comments", icon: MessageSquare },
  { key: "material-performance", label: "素材成效", to: "/material-performance", icon: TrendingUp },
  { key: "feishu-data", label: "已获取数据查阅", to: "/feishu-data", icon: Database },
  { key: "settings", label: "设置", to: "/settings", icon: Settings },
  { key: "api-test", label: "API测试", to: "/api-test", icon: TerminalSquare, position: "bottom" },
];

export function tabByPath(path: string): TabDef | undefined {
  // longest-prefix match (so /settings/foo matches /settings)
  return [...TABS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((t) => (t.to === "/" ? path === "/" : path.startsWith(t.to)));
}
