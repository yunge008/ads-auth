import * as React from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseCrawlFile, type CrawlParsed } from "@/lib/reviewCrawl";
import { reviewsApi, type Meta, type Reconcile } from "@/lib/reviewsApi";
import { Help } from "./shared";

const DAILY_CHUNK = 4000;
const TEXT_CHUNK = 1000;
// 留言行入库后的估算体积（含中文、索引），用于上传前提示
const BYTES_PER_TEXT = 350;

/** 数据：上传抓取表 / 各站点覆盖与同步状态 / 接口核对（管理员） */
export function DataPanel({ meta, onChanged }: { meta: Meta | null; onChanged: () => void }) {
  const [parsed, setParsed] = React.useState<CrawlParsed[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    const out: CrawlParsed[] = [];
    for (const f of Array.from(files)) {
      setBusy(`解析 ${f.name}`);
      try { out.push(await parseCrawlFile(f)); } catch (e) { toast.error((e as Error).message); }
    }
    setBusy(null);
    setParsed(out);
    if (fileRef.current) fileRef.current.value = "";
  };

  const upload = async () => {
    try {
      for (const p of parsed) {
        setBusy(`${p.file}：开始`);
        const { upload_id } = await reviewsApi.uploadBegin({
          shop_key: p.shop_key, file_name: p.file, range_from: p.range_from, range_to: p.range_to,
          rows_total: p.rows_total, rows_in_range: p.rows_in_range, rows_text: p.texts.length, products: p.products,
        });
        for (let i = 0; i < p.daily.length; i += DAILY_CHUNK) {
          setBusy(`${p.file}：逐日星级 ${Math.min(i + DAILY_CHUNK, p.daily.length)}/${p.daily.length}`);
          await reviewsApi.uploadDaily(p.shop_key, p.daily.slice(i, i + DAILY_CHUNK));
        }
        for (let i = 0; i < p.texts.length; i += TEXT_CHUNK) {
          setBusy(`${p.file}：评价内容 ${Math.min(i + TEXT_CHUNK, p.texts.length)}/${p.texts.length}`);
          await reviewsApi.uploadTexts(p.shop_key, p.texts.slice(i, i + TEXT_CHUNK));
        }
        await reviewsApi.uploadEnd(p.shop_key, upload_id);
      }
      toast.success(`已入库 ${parsed.length} 个文件`);
      setParsed([]);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(null); }
  };

  const totalText = parsed.reduce((a, p) => a + p.texts.length, 0);
  const shops = React.useMemo(() => {
    const keys = new Set([...(meta?.api_sites ?? []), ...(meta?.shops ?? []).map((s) => s.shop_key)]);
    return [...keys].sort().map((k) => ({ key: k, api: meta?.api_sites.includes(k) ?? false, s: meta?.shops.find((x) => x.shop_key === k) }));
  }, [meta]);

  return (
    <div className="grid gap-3">
      <Card><CardContent className="p-3 grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} id="rv-files" type="file" accept=".xlsx,.xls" multiple className="hidden" onChange={(e) => pick(e.target.files)} />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={!!busy}><Upload className="h-4 w-4 mr-1" />选择抓取表</Button>
          <Help label="抓取表格式" text="文件名「站点 YYMMDD-YYMMDD.xlsx」或「站点 ALL YYMMDD-YYMMDD.xlsx」，读 sheet「评论」。全部行按评论时间逐日统计星级，评论时间不在文件名日期段内的行不计。只存有留言或有回复的行（原文、中文译文、回复、订单号等），不存用户名和图片链接。同站点同日期段重复上传会整段替换，不会重复计数。中文译文列：表头含「翻译」或「中文」。" />
          {parsed.length > 0 && <Button size="sm" onClick={upload} disabled={!!busy}>入库 {parsed.length} 个文件</Button>}
          {busy && <span className="text-xs text-muted-foreground">{busy}</span>}
        </div>
        {parsed.length > 0 && (
          <div className="rounded-md border overflow-x-auto">
            <Table className="tabular-nums text-sm">
              <TableHeader><TableRow>
                <TableHead>文件</TableHead><TableHead>站点</TableHead><TableHead>日期段</TableHead>
                <TableHead className="text-right">评价</TableHead><TableHead className="text-right">段外</TableHead><TableHead className="text-right">重复/坏行</TableHead>
                <TableHead className="text-right">有留言</TableHead><TableHead className="text-right">商品</TableHead><TableHead>中文列</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {parsed.map((p) => (
                  <TableRow key={p.file}>
                    <TableCell className="max-w-[240px] truncate" title={p.file}>{p.file}</TableCell>
                    <TableCell>{p.shop_key}{!meta?.api_sites.includes(p.shop_key) && <span className="ml-1 text-[11px] text-muted-foreground">无接口</span>}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.range_from} – {p.range_to}</TableCell>
                    <TableCell className="text-right">{p.rows_in_range.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{p.out_of_range}</TableCell>
                    <TableCell className="text-right">{p.dup + p.bad}</TableCell>
                    <TableCell className="text-right">{p.texts.length.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{p.products}</TableCell>
                    <TableCell className="text-xs">{p.zh_col ?? <span className="text-muted-foreground">无</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="px-3 py-2 text-xs text-muted-foreground border-t">留言约占 {(totalText * BYTES_PER_TEXT / 1e6).toFixed(1)} MB</div>
          </div>
        )}
      </CardContent></Card>

      <div className="rounded-md border overflow-x-auto">
        <Table className="tabular-nums text-sm">
          <TableHeader><TableRow>
            <TableHead>站点</TableHead>
            <TableHead><span className="inline-flex items-center gap-1">抓取表覆盖<Help label="抓取表覆盖说明" text="这段日期的星级用抓取表；之后的日期用接口逐日数据。" /></span></TableHead>
            <TableHead>接口同步到</TableHead><TableHead>最近同步</TableHead><TableHead>今晚进度</TableHead><TableHead>错误</TableHead>
            {meta?.is_admin && <TableHead />}
          </TableRow></TableHeader>
          <TableBody>
            {shops.map(({ key, api, s }) => (
              <TableRow key={key}>
                <TableCell>{key}</TableCell>
                <TableCell className="whitespace-nowrap">{s?.crawl_from ? `${s.crawl_from} – ${s.crawl_until}` : "—"}</TableCell>
                <TableCell>{api ? s?.api_until ?? "—" : <span className="text-muted-foreground">无授权店铺</span>}</TableCell>
                <TableCell className="text-xs">{s?.last_run_at?.slice(0, 16).replace("T", " ") ?? "—"}</TableCell>
                <TableCell className="text-xs">{s?.run_date ? `${s.run_date} ${s.run_done ? "完成" : `${s.run_idx}/${s.run_total}`}` : "—"}</TableCell>
                <TableCell className="text-xs text-red-600 max-w-[280px] truncate" title={s?.last_error ?? ""}>{s?.last_error ?? ""}</TableCell>
                {meta?.is_admin && <TableCell>{api && <SyncButton shop={key} onDone={onChanged} />}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {meta?.is_admin && <ReconcileCard sites={meta.api_sites} />}

      {!!meta?.uploads.length && (
        <details className="rounded-md border">
          <summary className="px-3 py-2 text-sm cursor-pointer">上传记录 {meta.uploads.length}</summary>
          <Table className="tabular-nums text-sm">
            <TableBody>
              {meta.uploads.map((u) => (
                <TableRow key={`${u.file_name}|${u.created_at}`}>
                  <TableCell className="text-xs">{u.created_at.slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell>{u.shop_key}</TableCell><TableCell className="truncate max-w-[240px]">{u.file_name}</TableCell>
                  <TableCell className="text-right">{u.rows_in_range.toLocaleString()}</TableCell><TableCell className="text-right">{u.rows_text.toLocaleString()}</TableCell>
                  <TableCell className={u.status === "READY" ? "" : "text-red-600"}>{u.status === "READY" ? "完成" : "未完成"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{u.uploaded_by}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      )}
    </div>
  );
}

function SyncButton({ shop, onDone }: { shop: string; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await reviewsApi.step(shop);
      const x = r.results[0];
      if (x?.error) toast.error(`${shop}：${x.error}`);
      else toast.success(x ? `${shop}：${x.idx}/${x.total}，接口调用 ${x.calls} 次${x.done ? "，已完成" : "，再点一次继续"}` : `${shop}：今晚已同步完`);
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return <Button size="sm" variant="ghost" onClick={run} disabled={busy}>{busy ? "同步中…" : "同步"}</Button>;
}

function ReconcileCard({ sites }: { sites: string[] }) {
  const [site, setSite] = React.useState(sites[0] ?? "PH");
  const [from, setFrom] = React.useState("2026-11-01");
  const [to, setTo] = React.useState("2026-11-09");
  const [pids, setPids] = React.useState("");
  const [res, setRes] = React.useState<Reconcile | null>(null);
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try { setRes(await reviewsApi.reconcile(site, from, to, pids.split(/[\s,，]+/).filter(Boolean))); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const fmt = (s: number[]) => [4, 3, 2, 1, 0].map((i) => s[i]).join(" / ");
  return (
    <Card><CardContent className="p-3 grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">接口核对</span>
        <Help label="接口核对说明" text="对每个商品：接口逐日查询 vs 抓取表同日的 1–5 星条数（检验接口按评论日期统计）；整段一次查询 vs 逐日之和（检验可加性，每晚同步依赖它）。不填商品 ID 时取该段抓取表评价最多的 3 个。只读，不写库。" />
        <select id="rv-rc-site" aria-label="站点" value={site} onChange={(e) => setSite(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm">
          {sites.map((s) => <option key={s}>{s}</option>)}
        </select>
        <Input id="rv-rc-from" type="date" aria-label="开始" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-auto" />
        <Input id="rv-rc-to" type="date" aria-label="结束" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-auto" />
        <Input id="rv-rc-pids" placeholder="商品 ID（可空）" value={pids} onChange={(e) => setPids(e.target.value)} className="h-8 w-56 font-mono" />
        <Button size="sm" onClick={run} disabled={busy}>{busy ? "核对中…" : "核对"}</Button>
      </div>
      {res && res.products.map((p) => (
        <div key={p.pid} className="rounded-md border overflow-x-auto">
          <div className="px-3 py-2 text-sm flex flex-wrap gap-x-4 gap-y-1 border-b tabular-nums">
            <span className="font-mono">{p.pid}</span>
            <span className={p.match_days === p.total_days ? "text-green-600" : "text-red-600"}>逐日一致 {p.match_days}/{p.total_days}</span>
            <span className={p.additive ? "text-green-600" : "text-red-600"}>可加性 {p.additive ? "成立" : "不成立"}（整段 {fmt(p.whole)} · 逐日和 {fmt(p.sum_of_days)}）</span>
          </div>
          <Table className="tabular-nums text-xs">
            <TableHeader><TableRow><TableHead>日期</TableHead><TableHead className="text-right">接口 5→1★</TableHead><TableHead className="text-right">抓取表 5→1★</TableHead><TableHead className="text-right">出单</TableHead></TableRow></TableHeader>
            <TableBody>
              {p.days.map((d) => (
                <TableRow key={d.d} className={d.same ? "" : "bg-red-500/10"}>
                  <TableCell>{d.d}</TableCell><TableCell className="text-right">{fmt(d.api)}</TableCell><TableCell className="text-right">{fmt(d.crawl)}</TableCell><TableCell className="text-right">{d.orders}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </CardContent></Card>
  );
}
