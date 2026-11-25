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
export function Help({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label ?? text} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="inline-flex text-muted-foreground align-middle hover:text-foreground">
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{text}</TooltipContent>
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
