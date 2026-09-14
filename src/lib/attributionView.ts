// GMV 归因页面的视图状态（模块级 store）。
//
// 为什么不放组件 state：两个归因页面都在 Tabs / 路由里，切走就卸载，回来时月份、已加载的报表、
// 已展开的明细全部丢失，用户得重新查一遍——而查一次是要跑服务端的。这里把「查出来的东西」留在内存里，
// 切标签页 / 切路由回来直接还原；顺带镜像一份到 sessionStorage，整页刷新后也还在。
import type { AttributionReport, DetailRow, RefreshProgress, RunMeta } from "@/lib/attributionApi";
import { lastMonth } from "@/lib/attributionApi";

export type ViewKey = "admin-monthly" | "user";

export type ReportView = {
  month: string;
  report: AttributionReport | null;
  run: RunMeta | null;
  /** 最近一次读取快照的时间，用于展示「数据取自 …」 */
  loadedAt: number | null;
  detail: { rows: DetailRow[]; title: string } | null;
  /** 重算进行中也放这里：切 TAB/切路由回来进度还在（重算的轮询回调会一直 patch 这个字段） */
  refreshing: boolean;
  /** 重算开始的时间戳；已等待秒数由页面每秒本地计算，不依赖服务端回调的节奏 */
  refreshStartedAt: number | null;
  refreshSecs: number;
  /** 分片判定进度：判完一片就更新一次，切 TAB 回来也还在 */
  refreshProgress: RefreshProgress | null;
};

const SS_KEY = "tt_attr_view_v1";

function emptyView(): ReportView {
  return {
    month: lastMonth(), report: null, run: null, loadedAt: null, detail: null,
    refreshing: false, refreshStartedAt: null, refreshSecs: 0, refreshProgress: null,
  };
}

let state: Record<ViewKey, ReportView> = {
  "admin-monthly": emptyView(),
  user: emptyView(),
};
const listeners = new Set<() => void>();

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SS_KEY, JSON.stringify(state));
  } catch {
    /* 配额满/隐私模式：视图缓存不是关键路径 */
  }
}

function restore() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(SS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Record<ViewKey, ReportView>>;
    state = {
      "admin-monthly": { ...emptyView(), ...(parsed["admin-monthly"] ?? {}) },
      user: { ...emptyView(), ...(parsed.user ?? {}) },
    };
    // 整页刷新后轮询回调已不存在，重算状态必须复位，否则会卡在转圈
    state["admin-monthly"].refreshing = false;
    state.user.refreshing = false;
    state["admin-monthly"].refreshStartedAt = null;
    state.user.refreshStartedAt = null;
  } catch {
    /* 坏数据忽略 */
  }
}
restore();

export const attributionView = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): Record<ViewKey, ReportView> {
    return state;
  },
  getServerSnapshot(): Record<ViewKey, ReportView> {
    return state;
  },
  get(key: ViewKey): ReportView {
    return state[key];
  },
  patch(key: ViewKey, patch: Partial<ReportView>) {
    state = { ...state, [key]: { ...state[key], ...patch } };
    persist();
    for (const l of listeners) l();
  },
  reset(key: ViewKey) {
    state = { ...state, [key]: emptyView() };
    persist();
    for (const l of listeners) l();
  },
};
