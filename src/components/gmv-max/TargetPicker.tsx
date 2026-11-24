// 目标广告户 + 店铺授权 BC 选择：先选广告户，BC 从该户所在的授权连接带出。
// 只有一个 BC 直接显示；多个时下拉选择，默认授权时间最新的连接（切户后 BC 可能变）。
import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnections } from "@/lib/store";

export type AdvOption = { id: string; name: string; shopId: string | null; bcId: string | null };
export type BcOption = { bcId: string; bcName: string; createdAt: string };

export function useBcOptions(advertiserId: string): BcOption[] {
  const { connections } = useConnections();
  return React.useMemo(() => {
    const byBc = new Map<string, BcOption>();
    for (const c of connections) {
      if (!c.bc_id || !c.advertiser_ids.includes(advertiserId)) continue;
      const prev = byBc.get(c.bc_id);
      if (!prev || c.created_at > prev.createdAt) byBc.set(c.bc_id, { bcId: c.bc_id, bcName: c.bc_name ?? c.label ?? c.bc_id, createdAt: c.created_at });
    }
    return Array.from(byBc.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [connections, advertiserId]);
}

export function TargetPicker({
  advOptions, advertiserId, onAdvertiserChange, bcId, onBcChange, advLabel = "目标广告户", disabled,
}: {
  advOptions: AdvOption[];
  advertiserId: string;
  onAdvertiserChange: (v: string) => void;
  bcId: string;
  onBcChange: (v: string) => void;
  advLabel?: string;
  disabled?: boolean;
}) {
  const bcs = useBcOptions(advertiserId);
  // 换户或 BC 列表变化时，默认选授权时间最新的 BC
  React.useEffect(() => {
    if (!advertiserId) { if (bcId) onBcChange(""); return; }
    if (!bcs.some((b) => b.bcId === bcId)) onBcChange(bcs[0]?.bcId ?? "");
  }, [advertiserId, bcs, bcId, onBcChange]);

  return (
    <>
      <Select value={advertiserId} onValueChange={onAdvertiserChange} disabled={disabled}>
        <SelectTrigger aria-label={advLabel} className="w-72"><SelectValue placeholder={advLabel} /></SelectTrigger>
        <SelectContent>
          {advOptions.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}（{a.id}）</SelectItem>)}
        </SelectContent>
      </Select>
      {advertiserId && (
        <Select value={bcId} onValueChange={onBcChange} disabled={disabled || !bcs.length}>
          <SelectTrigger aria-label="店铺授权 BC" className="w-72">
            <SelectValue placeholder={bcs.length ? "选择 BC" : "该户无授权 BC"} />
          </SelectTrigger>
          <SelectContent>
            {bcs.map((b) => <SelectItem key={b.bcId} value={b.bcId}>{b.bcName}（{b.bcId}）</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </>
  );
}
