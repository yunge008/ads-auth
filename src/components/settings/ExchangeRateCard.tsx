// GMV 归因用汇率维护：usd_rate 语义 = 1 美元兑多少本币（如 THB 填 33）。改了直接生效于下次归因计算。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { type ExchangeRateRec, exchangeRateApi } from "@/lib/attributionApi";

export function ExchangeRateCard() {
  const [rates, setRates] = React.useState<ExchangeRateRec[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [newCurrency, setNewCurrency] = React.useState("");
  const [newRate, setNewRate] = React.useState("");

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const { rates } = await exchangeRateApi.list();
      setRates(rates ?? []);
    } catch (e) {
      toast.error(`加载汇率失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  const save = async (currency: string, usd_rate: number, enabled: boolean) => {
    setSaving(currency);
    try {
      await exchangeRateApi.save({ currency, usd_rate, enabled });
      toast.success(`${currency} 已保存`);
      await reload();
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(null);
    }
  };

  const addNew = async () => {
    const currency = newCurrency.trim().toUpperCase();
    const rate = Number(newRate);
    if (!currency) { toast.error("请输入币种代码，如 THB"); return; }
    if (!isFinite(rate) || rate <= 0) { toast.error("汇率必须为正数"); return; }
    await save(currency, rate, true);
    setNewCurrency("");
    setNewRate("");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">GMV 归因汇率</CardTitle>
        <p className="text-xs text-muted-foreground">
          usd_rate 语义：1 美元 = 多少本币（如泰铢填 33）。归因折美元 = 本币金额 / 该汇率。改了直接生效于下次归因计算，不保留历史版本。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="outline" onClick={reload} disabled={loading}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
          <div className="flex items-end gap-1.5">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">币种代码</span>
              <Input value={newCurrency} onChange={(e) => setNewCurrency(e.target.value)} placeholder="THB" className="h-8 w-24" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">1 美元 = ? 本币</span>
              <Input value={newRate} onChange={(e) => setNewRate(e.target.value)} placeholder="33" className="h-8 w-28" />
            </div>
            <Button size="sm" onClick={addNew} disabled={!!saving}>
              <Plus className="h-4 w-4 mr-1.5" />新增/更新
            </Button>
          </div>
        </div>
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>币种</TableHead>
                <TableHead className="text-right">1 美元 = ? 本币</TableHead>
                <TableHead>启用</TableHead>
                <TableHead>更新人/时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-16 text-center text-sm text-muted-foreground">暂无汇率配置</TableCell></TableRow>
              ) : rates.map((r) => (
                <RateRow key={r.currency} rate={r} onSave={save} saving={saving === r.currency} />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RateRow({
  rate, onSave, saving,
}: {
  rate: ExchangeRateRec;
  onSave: (currency: string, usd_rate: number, enabled: boolean) => Promise<void>;
  saving: boolean;
}) {
  const [val, setVal] = React.useState(String(rate.usd_rate));
  React.useEffect(() => setVal(String(rate.usd_rate)), [rate.usd_rate]);
  const isUsd = rate.currency === "USD";
  return (
    <TableRow>
      <TableCell className="font-medium">{rate.currency}</TableCell>
      <TableCell className="text-right">
        <Input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const n = Number(val);
            if (isFinite(n) && n > 0 && n !== rate.usd_rate) onSave(rate.currency, n, rate.enabled);
          }}
          disabled={isUsd || saving}
          className="h-7 w-24 ml-auto text-right"
        />
      </TableCell>
      <TableCell>
        <Switch
          checked={rate.enabled}
          disabled={isUsd || saving}
          onCheckedChange={(v) => onSave(rate.currency, rate.usd_rate, v)}
        />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {rate.updated_by || "—"} · {new Date(rate.updated_at).toLocaleString()}
      </TableCell>
    </TableRow>
  );
}
