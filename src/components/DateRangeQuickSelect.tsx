import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Props = {
  onPick: (start: string, end: string) => void;
  className?: string;
};

function fmt(d: Date) {
  return d.toISOString().slice(0, 10);
}

function compute(key: string): [string, string] | null {
  const today = new Date();
  const end = fmt(today);
  if (key === "7") return [fmt(new Date(Date.now() - 7 * 86400 * 1000)), end];
  if (key === "15") return [fmt(new Date(Date.now() - 15 * 86400 * 1000)), end];
  if (key === "30") return [fmt(new Date(Date.now() - 30 * 86400 * 1000)), end];
  if (key === "90") return [fmt(new Date(Date.now() - 90 * 86400 * 1000)), end];
  if (key === "lastmonth") {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth();
    const first = new Date(Date.UTC(y, m - 1, 1));
    const last = new Date(Date.UTC(y, m, 0));
    return [fmt(first), fmt(last)];
  }
  return null;
}

export function DateRangeQuickSelect({ onPick, className }: Props) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs text-muted-foreground">快捷</span>
      <Select
        onValueChange={(v) => {
          const r = compute(v);
          if (r) onPick(r[0], r[1]);
        }}
      >
        <SelectTrigger className="h-8 w-32">
          <SelectValue placeholder="选择范围" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7">过去 7 天</SelectItem>
          <SelectItem value="15">过去 15 天</SelectItem>
          <SelectItem value="30">过去 30 天</SelectItem>
          <SelectItem value="lastmonth">上个月</SelectItem>
          <SelectItem value="90">过去 90 天</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
