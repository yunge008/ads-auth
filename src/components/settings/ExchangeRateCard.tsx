// 汇率设置（全局）：usd_rate 语义 = 1 美元兑多少本币（如 THB 填 33）。
// 用于 GMV 归因折美元、申样审核达人 GMV 折美元等所有本币→美元换算；改了直接生效。
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { type ExchangeRateRec, exchangeRateApi } from "@/lib/attributionApi";

// 固定站点（负责人 2026-11-17 指定），即使表里还没有也显示一行，填了即创建
const SITE_CURRENCY: Array<[string, string]> = [
  ["PH", "PHP"], ["TH", "THB"], ["VN", "VND"], ["MY", "MYR"], ["SG", "SGD"], ["MX", "MXN"], ["JP", "JPY"], ["US", "USD"],
];

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
        <CardTitle className="text-base">汇率设置</CardTitle>
        <p className="text-xs text-muted-foreground">
          1 美元 = 多少本币（如泰铢填 33）。全局使用：GMV 归因、申样审核等所有折美元 = 本币金额 / 该汇率。改了直接生效，不保留历史版本。
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
                <TableHead>站点</TableHead>
                <TableHead>币种</TableHead>
                <TableHead className="text-right">1 美元 = ? 本币</TableHead>
                <TableHead>启用</TableHead>
                <TableHead>更新人/时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ...SITE_CURRENCY.map(([site, cur]) => ({
                  site,
                  rate: rates.find((r) => r.currency === cur) ?? { currency: cur, usd_rate: cur === "USD" ? 1 : 0, enabled: false, updated_at: "", updated_by: null },
                })),
                ...rates.filter((r) => !SITE_CURRENCY.some(([, c]) => c === r.currency)).map((r) => ({ site: "—", rate: r })),
              ].map(({ site, rate }) => (
                <RateRow key={rate.currency} site={site} rate={rate} onSave={save} saving={saving === rate.currency} />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function RateRow({
  site, rate, onSave, saving,
}: {
  site: string;
  rate: ExchangeRateRec;
  onSave: (currency: string, usd_rate: number, enabled: boolean) => Promise<void>;
  saving: boolean;
}) {
  const isNew = !rate.updated_at; // 表里还没有：填了汇率即创建并启用
  const [val, setVal] = React.useState(rate.usd_rate ? String(rate.usd_rate) : "");
  React.useEffect(() => setVal(rate.usd_rate ? String(rate.usd_rate) : ""), [rate.usd_rate]);
  const isUsd = rate.currency === "USD" && !isNew;
  return (
    <TableRow>
      <TableCell>{site}</TableCell>
      <TableCell className="font-medium">{rate.currency}</TableCell>
      <TableCell className="text-right">
        <Input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const n = Number(val);
            if (isFinite(n) && n > 0 && (n !== rate.usd_rate || isNew)) onSave(rate.currency, n, isNew ? true : rate.enabled);
          }}
          disabled={isUsd || saving}
          placeholder={isNew ? "未设置" : ""}
          className="h-7 w-24 ml-auto text-right"
        />
      </TableCell>
      <TableCell>
        <Switch
          checked={rate.enabled}
          disabled={isUsd || isNew || saving}
          onCheckedChange={(v) => onSave(rate.currency, rate.usd_rate, v)}
        />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {isNew ? "未设置" : `${rate.updated_by || "—"} · ${new Date(rate.updated_at).toLocaleString()}`}
      </TableCell>
    </TableRow>
  );
}
