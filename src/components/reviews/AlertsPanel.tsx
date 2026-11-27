import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reviewsApi, type AlertItem, type Meta } from "@/lib/reviewsApi";
import { f2, Help, ListingLabel, Pager, useFitRows } from "./shared";

/** 差评提示：门槛设置 + 当前低于门槛的链接（每晚同步后，新跌破的合并发一条飞书） */
export function AlertsPanel({ ver, meta, onSaved, onPick }: { ver: number; meta: Meta | null; onSaved: () => void; onPick: (pid: string) => void }) {
  const [min, setMin] = React.useState("10");
  const [thr, setThr] = React.useState("4.0");
  const [items, setItems] = React.useState<AlertItem[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const per = useFitRows(boxRef);
  const [page, setPage] = React.useState(0);
  React.useEffect(() => setPage(0), [items, per]);
  const pages = Math.max(1, Math.ceil((items?.length ?? 0) / per));
  React.useEffect(() => {
    if (meta?.settings) { setMin(String(meta.settings.min_reviews)); setThr(Number(meta.settings.threshold).toFixed(1)); }
  }, [meta?.settings]);
  const load = React.useCallback(() => {
    setItems(null);
    reviewsApi.alerts().then((r) => setItems(r.items)).catch((e) => { toast.error((e as Error).message); setItems([]); });
  }, []);
  React.useEffect(load, [load, ver]);

  const save = async () => {
    setSaving(true);
    try {
      await reviewsApi.saveSettings(Number(min), Number(thr));
      toast.success("已保存");
      onSaved();
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };
  const dirty = meta?.settings && (Number(min) !== meta.settings.min_reviews || Number(thr) !== Number(meta.settings.threshold));

  return (
    <div className="grid gap-3">
      <Card><CardContent className="p-3 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">评价数门槛<Help label="评价数门槛说明" text={["累计评价少于此数不提示", "避免新链接 1 条低分就触发"]} /></span>
          <Input id="rv-min" type="number" min={1} max={1000} value={min} onChange={(e) => setMin(e.target.value)} className="w-24 tabular-nums" />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">提示分数<Help label="提示分数说明" text={["累计平均分低于此分 → 每晚同步后发飞书", "内容：站点、SKU、商品 ID、当前分、近 30 天评论 / 差评", "回到此分以上后再跌破，会再提示一次"]} /></span>
          <Input id="rv-thr" type="number" min={1} max={5} step={0.1} value={thr} onChange={(e) => setThr(e.target.value)} className="w-24 tabular-nums" />
        </label>
        <Button size="sm" onClick={save} disabled={saving || !dirty}>{saving ? "保存中…" : "保存"}</Button>
        {meta?.settings?.updated_by && <span className="text-xs text-muted-foreground ml-auto">{meta.settings.updated_by} · {meta.settings.updated_at?.slice(0, 16).replace("T", " ")}</span>}
      </CardContent></Card>

      <div ref={boxRef} className="grid gap-2">
      <div className="rounded-md border overflow-x-auto">
        <Table className="table-fixed min-w-[900px] tabular-nums text-sm">
          <colgroup><col style={{ width: 84 }} /><col /><col style={{ width: 110 }} /><col style={{ width: 100 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 110 }} /></colgroup>
          <TableHeader><TableRow>
            <TableHead>站点</TableHead><TableHead>SKU / 名称 / 商品 ID</TableHead>
            <TableHead className="text-right">累计平均分</TableHead><TableHead className="text-right">累计评价</TableHead>
            <TableHead className="text-right">近 30 天评论</TableHead><TableHead className="text-right">近 30 天差评</TableHead>
            <TableHead className="text-right">已提示</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {items === null && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">加载中…</TableCell></TableRow>}
            {items?.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">没有低于门槛的链接</TableCell></TableRow>}
            {items?.slice(page * per, page * per + per).map((x) => (
              <TableRow key={`${x.site}|${x.pid}`} className="cursor-pointer" tabIndex={0} onClick={() => onPick(x.pid)} onKeyDown={(e) => { if (e.key === "Enter") onPick(x.pid); }}>
                <TableCell>{x.site}</TableCell>
                <TableCell className="overflow-hidden"><ListingLabel sku={x.sku} title={x.title} pid={x.pid} /></TableCell>
                <TableCell className="text-right text-red-600">{f2(x.avg)}</TableCell>
                <TableCell className="text-right">{x.n.toLocaleString()}</TableCell>
                <TableCell className="text-right">{x.n30}</TableCell>
                <TableCell className={`text-right ${x.bad30 ? "text-red-600" : ""}`}>{x.bad30}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">{x.new ? "待下次同步" : x.alerted_at?.slice(0, 10) ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pager page={page} pages={pages} total={items?.length ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}
