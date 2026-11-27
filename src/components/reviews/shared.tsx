import * as React from "react";
import { CircleHelp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// 星级语义色（好→差），两种主题下都可读
export const STAR_COLORS = ["#dc2626", "#f97316", "#eab308", "#84cc16", "#16a34a"] as const;
export const f2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2));
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
/** 北京时间昨天（接口数据 T+1） */
export const yesterday = () => addDays(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), -1);

/** 「?」说明：悬停、键盘聚焦、点按都能显示 */
/** 「?」说明：传字符串数组时按分点显示（项目规则：每点一句、只写口径，见 AGENTS.md「前端说明文字」）*/
export function Help({ text, label }: { text: React.ReactNode | string[]; label?: string }) {
  const body = Array.isArray(text)
    ? <ul className="list-disc space-y-0.5 pl-4">{text.map((t, i) => <li key={i}>{t}</li>)}</ul>
    : text;
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label ?? (typeof text === "string" ? text : "说明")} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="inline-flex text-muted-foreground align-middle hover:text-foreground">
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{body}</TooltipContent>
    </Tooltip>
  );
}

/** 星级分布条；悬停/聚焦按 5→1 星逐行显示条数（右对齐） */
export function StarBar({ s }: { s: number[] }) {
  const t = s.reduce((a, b) => a + b, 0) || 1;
  const label = [4, 3, 2, 1, 0].map((i) => `${i + 1}星 ${s[i]} 条`).join("，");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={label} onClick={(e) => e.stopPropagation()}
          className="inline-flex w-24 h-2 rounded-sm overflow-hidden bg-muted align-middle cursor-default">
          {s.map((v, i) => <i key={i} style={{ width: `${(v / t) * 100}%`, background: STAR_COLORS[i] }} />)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="p-2">
        <div className="grid grid-cols-[auto_auto] gap-x-3 text-xs tabular-nums">
          {[4, 3, 2, 1, 0].map((i) => (
            <React.Fragment key={i}>
              <span style={{ color: STAR_COLORS[i] }}>{i + 1}★</span>
              <span className="text-right">{s[i].toLocaleString()}</span>
            </React.Fragment>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 表格分页：每页行数按视口剩余高度算，保证整页不用上下滚动。
 * ref 指向表格外层；rowH = 单行高度（两行文字约 52px）；reserve = 表头 + 分页条 + 底部留白。
 */
export function useFitRows(ref: React.RefObject<HTMLElement | null>, rowH = 52, reserve = 110) {
  const [n, setN] = React.useState(10);
  React.useLayoutEffect(() => {
    const calc = () => {
      const el = ref.current;
      if (!el || !el.offsetParent) return; // 隐藏中的 TAB 不算
      const top = el.getBoundingClientRect().top;
      setN(Math.max(5, Math.floor((window.innerHeight - top - reserve) / rowH)));
    };
    calc();
    window.addEventListener("resize", calc);
    const ro = new ResizeObserver(calc);
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    return () => { window.removeEventListener("resize", calc); ro.disconnect(); };
  }, [ref, rowH, reserve]);
  return n;
}

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return <div className="text-xs text-muted-foreground tabular-nums px-1">共 {total.toLocaleString()} 条</div>;
  const btn = "h-7 min-w-7 rounded-md border px-2 text-xs disabled:opacity-40 hover:bg-muted";
  return (
    <nav className="flex items-center gap-1 text-xs tabular-nums" aria-label="分页">
      <span className="text-muted-foreground mr-2">共 {total.toLocaleString()} 条</span>
      <button type="button" className={btn} disabled={page <= 0} onClick={() => onPage(0)} aria-label="第一页">«</button>
      <button type="button" className={btn} disabled={page <= 0} onClick={() => onPage(page - 1)} aria-label="上一页">‹</button>
      <span className="px-2">{page + 1} / {pages}</span>
      <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="下一页">›</button>
      <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} aria-label="最后一页">»</button>
    </nav>
  );
}

/** 第一个 SKU 只保留字母前缀 + 3–4 位数字（AR333-A-K → AR333，NE103-C+205-C → NE103）；认不出就用第一个 SKU 原样 */
export function shortSku(sku: string | null | undefined): string {
  const first = String(sku ?? "").split(/\s*\/\s*/)[0]?.trim() ?? "";
  const m = first.match(/^([A-Za-z]{1,4})(\d{3,4})/);
  return m ? `${m[1].toUpperCase()}${m[2]}` : first;
}
/** listing 名称以 . ' ’ ‘ | ~ 结尾时，前面加【符号-链接】提示 */
export function titleMark(title: string | null | undefined): string | null {
  const t = String(title ?? "").trim();
  const ch = t.slice(-1);
  return ch && ".'’‘|~".includes(ch) ? `【${ch}-链接】` : null;
}

/** 链接标识：简写 SKU（悬停看全部 SKU）+ listing 名称（放不下省略，悬停看全名）+ 商品 ID */
export function ListingLabel({ sku, title, pid, showPid = true, className = "" }: { sku: string | null; title?: string | null; pid: string; showPid?: boolean; className?: string }) {
  const mark = titleMark(title);
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-medium" title={sku ?? ""}>{shortSku(sku) || "—"}</span>
        {title && (
          <span className="truncate text-muted-foreground" title={title}>
            {mark && <span className="text-amber-600">{mark}</span>}{title}
          </span>
        )}
      </div>
      {showPid && <div className="font-mono text-[11px] text-muted-foreground">{pid}</div>}
    </div>
  );
}
