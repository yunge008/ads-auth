import * as React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronRight } from "lucide-react";
import { addS, avgS, reviewsApi, sumS, type SkuTable, type TableRow as Row } from "@/lib/reviewsApi";
import { f2, Help, ListingLabel, Pager, pct, StarBar, useFitRows } from "./shared";

type K = "site" | "sku" | "cum" | "delta" | "cnt" | "avg" | "bad" | "badr" | "ord" | "revr" | "obadr";
const COLS: { k: K; label: string; help?: string; left?: boolean }[] = [
  { k: "site", label: "站点", left: true },
  { k: "sku", label: "SKU / 名称 / 商品 ID", left: true },
  { k: "cum", label: "累计平均分", help: "截至结束日全部历史评价的加权平均（listing 显示分）。" },
  { k: "delta", label: "区间变化", help: "累计平均分在所选区间内的变化。" },
  { k: "cnt", label: "评价数" },
  { k: "avg", label: "区间均分" },
  { k: "bad", label: "差评数", help: "1–2 星条数。" },
  { k: "badr", label: "差评率", help: "差评数 / 评价数。" },
  { k: "ord", label: "出单量", help: "区间内订单数（接口 sales.orders，按下单日）。" },
  { k: "revr", label: "留评率", help: "评价数 / 出单量，只算区间内评价和出单都有数据的日子（出单从 orders 覆盖起点开始；首次同步前那几天评价是合计，不计）。评价比下单晚，最近几天会偏低。" },
  { k: "obadr", label: "订单差评率", help: "差评数 / 出单量，统计日子同留评率。" },
];

export function LinksTable({ rows, onPick, picked, from, to }: { rows: Row[] | null; onPick: (pid: string) => void; picked: string | null; from: string; to: string }) {
  const [sort, setSort] = React.useState<{ k: K; dir: 1 | -1 }>({ k: "badr", dir: -1 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setOpen(new Set()), [from, to]);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const per = useFitRows(boxRef);
  const [page, setPage] = React.useState(0);
  React.useEffect(() => setPage(0), [rows, sort, per]);
  const toggle = (key: string) => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const data = React.useMemo(() => (rows ?? []).map((r) => {
    const end = addS(addS(r.base, r.range), r.rinit);
    const cnt = sumS(r.range), bad = r.range[0] + r.range[1];
    const cum = avgS(end), start = avgS(r.base);
    return {
      r, site: r.site, sku: r.sku ?? "", cum, delta: cum != null && start != null ? cum - start : null,
      cnt, avg: avgS(r.range), bad, badr: cnt ? bad / cnt : null, ord: r.orders,
      revr: r.cov_ord ? r.cov_n / r.cov_ord : null, obadr: r.cov_ord ? r.cov_bad / r.cov_ord : null,
    };
  }).sort((a, b) => {
    const A = a[sort.k], B = b[sort.k];
    if (typeof A === "string" || typeof B === "string") return String(A).localeCompare(String(B)) * sort.dir;
    return ((A ?? -1e9) - (B ?? -1e9)) * sort.dir;
  }), [rows, sort]);

  const pages = Math.max(1, Math.ceil(data.length / per));
  const shown = data.slice(page * per, page * per + per);
  if (!rows) return <div ref={boxRef} className="text-sm text-muted-foreground py-10 text-center">加载中…</div>;
  return (
    <div ref={boxRef} className="grid gap-2">
    <div className="rounded-md border overflow-x-auto">
      <Table className="tabular-nums text-sm">
        <TableHeader>
          <TableRow>
            {COLS.map((c) => (
              <TableHead key={c.k} className={`${c.left ? "" : "text-right"} whitespace-nowrap`}
                aria-sort={sort.k === c.k ? (sort.dir > 0 ? "ascending" : "descending") : "none"}>
                <span className={`inline-flex items-center gap-1 ${c.left ? "" : "justify-end"}`}>
                  <button type="button" className="hover:text-foreground"
                    onClick={() => setSort((s) => ({ k: c.k, dir: s.k === c.k ? (s.dir === 1 ? -1 : 1) : c.left ? 1 : -1 }))}>
                    {c.label}{sort.k === c.k ? (sort.dir > 0 ? " ↑" : " ↓") : ""}
                  </button>
                  {c.help && <Help text={c.help} label={`${c.label}口径`} />}
                </span>
              </TableHead>
            ))}
            <TableHead className="text-right whitespace-nowrap">星级分布</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 && <TableRow><TableCell colSpan={COLS.length + 1} className="text-center text-muted-foreground py-8">没有数据</TableCell></TableRow>}
          {shown.map((x) => {
            const key = `${x.site}|${x.r.pid}`;
            return (<React.Fragment key={key}>
            <TableRow tabIndex={0} aria-selected={picked === x.r.pid}
              className="cursor-pointer aria-selected:bg-muted" onClick={() => onPick(x.r.pid)}
              onKeyDown={(e) => { if (e.key === "Enter") onPick(x.r.pid); }}>
              <TableCell className="whitespace-nowrap">
                <button type="button" aria-expanded={open.has(key)} aria-label={`${open.has(key) ? "收起" : "展开"} SKU`}
                  onClick={(e) => { e.stopPropagation(); toggle(key); }} className="mr-1 inline-flex align-middle text-muted-foreground hover:text-foreground">
                  <ChevronRight className={`h-4 w-4 transition-transform ${open.has(key) ? "rotate-90" : ""}`} />
                </button>
                {x.site}
              </TableCell>
              <TableCell className="min-w-[280px] max-w-[480px]">
                <ListingLabel sku={x.r.sku} title={x.r.title} pid={x.r.pid} />
              </TableCell>
              <TableCell className="text-right">
                {f2(x.cum)}
                {x.r.below && <span className="ml-1 rounded px-1 text-[11px] bg-red-500/15 text-red-600">提示中</span>}
              </TableCell>
              <TableCell className={`text-right ${x.delta == null || Math.abs(x.delta) < 0.0005 ? "text-muted-foreground" : x.delta > 0 ? "text-green-600" : "text-red-600"}`}>
                {x.delta == null ? "—" : `${x.delta > 0 ? "+" : ""}${x.delta.toFixed(3)}`}
              </TableCell>
              <TableCell className="text-right">{x.cnt.toLocaleString()}</TableCell>
              <TableCell className="text-right">{f2(x.avg)}</TableCell>
              <TableCell className={`text-right ${x.bad ? "text-red-600" : ""}`}>{x.bad}</TableCell>
              <TableCell className="text-right">{pct(x.badr)}</TableCell>
              <TableCell className="text-right">{x.ord.toLocaleString()}</TableCell>
              <TableCell className="text-right">{pct(x.revr)}</TableCell>
              <TableCell className="text-right">{pct(x.obadr)}</TableCell>
              <TableCell className="text-right"><StarBar s={x.r.range} /></TableCell>
            </TableRow>
            {open.has(key) && <SkuRows site={x.site} pid={x.r.pid} from={from} to={to} cols={COLS.length + 1} />}
            </React.Fragment>);
          })}
        </TableBody>
      </Table>
    </div>
    <Pager page={page} pages={pages} total={data.length} onPage={setPage} />
    </div>
  );
}

/** 展开的 SKU 行：只有抓取表数据（接口没有 SKU 级星级），按累计评价数从高到低 */
function SkuRows({ site, pid, from, to, cols }: { site: string; pid: string; from: string; to: string; cols: number }) {
  const [d, setD] = React.useState<SkuTable | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let stale = false;
    reviewsApi.skuTable(site, pid, from, to).then((r) => { if (!stale) setD(r); }).catch((e) => { if (!stale) setErr((e as Error).message); });
    return () => { stale = true; };
  }, [site, pid, from, to]);
  if (err) return <TableRow><TableCell colSpan={cols} className="text-xs text-red-600 pl-10">{err}</TableCell></TableRow>;
  if (!d) return <TableRow><TableCell colSpan={cols} className="text-xs text-muted-foreground pl-10">加载中…</TableCell></TableRow>;
  if (!d.rows.length) return <TableRow><TableCell colSpan={cols} className="text-xs text-muted-foreground pl-10">没有 SKU 数据（需重新上传抓取表）</TableCell></TableRow>;
  return (
    <>
      {d.rows.map((k) => {
        const end = addS(k.base, k.range);
        const cnt = sumS(k.range), bad = k.range[0] + k.range[1];
        const cum = avgS(end), start = avgS(k.base);
        const delta = cum != null && start != null ? cum - start : null;
        return (
          <TableRow key={k.sku_id} className="bg-muted/40 text-xs">
            <TableCell />
            <TableCell className="pl-6 max-w-[420px]">
              <div className="truncate" title={k.spec ?? ""}>{k.spec ?? "—"}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{k.sku_id}</div>
            </TableCell>
            <TableCell className="text-right">{f2(cum)}<span className="ml-1 text-[11px] text-muted-foreground">{sumS(end)}</span></TableCell>
            <TableCell className={`text-right ${delta == null || Math.abs(delta) < 0.0005 ? "text-muted-foreground" : delta > 0 ? "text-green-600" : "text-red-600"}`}>
              {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`}
            </TableCell>
            <TableCell className="text-right">{cnt.toLocaleString()}</TableCell>
            <TableCell className="text-right">{f2(avgS(k.range))}</TableCell>
            <TableCell className={`text-right ${bad ? "text-red-600" : ""}`}>{bad}</TableCell>
            <TableCell className="text-right">{pct(cnt ? bad / cnt : null)}</TableCell>
            <TableCell className="text-right text-muted-foreground">—</TableCell>
            <TableCell className="text-right text-muted-foreground">—</TableCell>
            <TableCell className="text-right text-muted-foreground">—</TableCell>
            <TableCell className="text-right"><StarBar s={k.range} /></TableCell>
          </TableRow>
        );
      })}
      {d.crawl_until && to > d.crawl_until && (
        <TableRow className="bg-muted/40"><TableCell colSpan={cols} className="pl-10 text-[11px] text-muted-foreground">SKU 只统计到 {d.crawl_until}（抓取表），之后的评价接口不分 SKU</TableCell></TableRow>
      )}
    </>
  );
}
