// 视频账号面板：列出本次所选组用到的全部视频账号，标出来源 BC / 目标 BC 是否有授权；只能勾目标 BC 有的。
// 复制时每组只带「原组有 ∩ 已勾选」的账号。
import * as React from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";

export type IdentityRow = {
  identity_id: string; identity_type: string; name: string; groups: number;
  inSrc: boolean | null; inDst: boolean | null; // null = 未查到（查询失败或未选）
};

const Mark = ({ v, label }: { v: boolean | null; label: string }) =>
  v === null ? <span className="text-muted-foreground" aria-label={`${label}：未知`}>?</span>
    : v ? <Check className="h-4 w-4 text-emerald-600" aria-label={`${label}：有授权`} />
      : <X className="h-4 w-4 text-destructive" aria-label={`${label}：无授权`} />;

export function IdentityPanel({ items, checked, onToggle, srcLabel, dstLabel, loading }: {
  items: IdentityRow[]; checked: Set<string>; onToggle: (id: string, v: boolean) => void;
  srcLabel: string; dstLabel: string; loading: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  if (!items.length) return null;
  const usable = items.filter((i) => i.inDst !== false).length;
  const picked = items.filter((i) => checked.has(i.identity_id)).length;
  const lost = items.length - picked;
  return (
    <div className="border rounded text-xs">
      <button type="button" className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium">视频账号 {items.length}</span>
        <span className="text-muted-foreground">· 目标 BC 可用 {loading ? "…" : usable} · 已选 {picked}</span>
        {lost > 0 && !loading && <span className="text-amber-600">· {lost} 个不会带到新组</span>}
      </button>
      {open && (
        <div className="max-h-72 overflow-auto border-t">
          <table className="w-full">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-1 w-8"><span className="sr-only">带到新组</span></th>
                <th className="px-2 py-1">账号</th>
                <th className="px-2 py-1">类型</th>
                <th className="px-2 py-1 text-center" title={srcLabel}>来源 BC</th>
                <th className="px-2 py-1 text-center" title={dstLabel}>目标 BC</th>
                <th className="px-2 py-1 text-right">组数</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.identity_id} className={`border-t ${i.inDst === false ? "text-muted-foreground" : ""}`}>
                  <td className="px-3 py-1">
                    <input type="checkbox" aria-label={`带上 ${i.name || i.identity_id}`} checked={checked.has(i.identity_id)}
                      disabled={i.inDst === false} onChange={(e) => onToggle(i.identity_id, e.target.checked)} />
                  </td>
                  <td className="px-2 py-1">{i.name || "—"} <span className="font-mono text-muted-foreground">{i.identity_id}</span></td>
                  <td className="px-2 py-1">{i.identity_type}</td>
                  <td className="px-2 py-1"><div className="flex justify-center"><Mark v={i.inSrc} label="来源 BC" /></div></td>
                  <td className="px-2 py-1"><div className="flex justify-center"><Mark v={i.inDst} label="目标 BC" /></div></td>
                  <td className="px-2 py-1 text-right">{i.groups}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
