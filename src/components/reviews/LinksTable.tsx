import * as React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addS, avgS, sumS, type TableRow as Row } from "@/lib/reviewsApi";
import { f2, Help, pct, StarBar } from "./shared";

type K = "site" | "sku" | "cum" | "delta" | "cnt" | "avg" | "bad" | "badr" | "ord" | "revr" | "obadr";
const COLS: { k: K; label: string; help?: string; left?: boolean }[] = [
  { k: "site", label: "站点", left: true },
  { k: "sku", label: "SKU / 商品 ID", left: true },
  { k: "cum", label: "累计平均分", help: "截至结束日全部历史评价的加权平均（listing 显示分）。" },
  { k: "delta", label: "区间变化", help: "累计平均分在所选区间内的变化。" },
  { k: "cnt", label: "评价数" },
  { k: "avg", label: "区间均分" },
  { k: "bad", label: "差评数", help: "1–2 星条数。" },
  { k: "badr", label: "差评率", help: "差评数 / 评价数。" },
  { k: "ord", label: "出单量", help: "区间内订单数（接口 sales.orders，按下单日）。" },
  { k: "revr", label: "留评率", help: "区间评价数 / 区间出单量。评价比下单晚，最近几天会偏低。" },
  { k: "obadr", label: "订单差评率", help: "区间差评数 / 区间出单量。" },
];

export function LinksTable({ rows, onPick, picked }: { rows: Row[] | null; onPick: (pid: string) => void; picked: string | null }) {
  const [sort, setSort] = React.useState<{ k: K; dir: 1 | -1 }>({ k: "badr", dir: -1 });
  const data = React.useMemo(() => (rows ?? []).map((r) => {
    const end = addS(r.base, r.range);
    const cnt = sumS(r.range), bad = r.range[0] + r.range[1];
    const cum = avgS(end), start = avgS(r.base);
    return {
      r, site: r.site, sku: r.sku ?? "", cum, delta: cum != null && start != null ? cum - start : null,
      cnt, avg: avgS(r.range), bad, badr: cnt ? bad / cnt : null, ord: r.orders,
      revr: r.orders ? cnt / r.orders : null, obadr: r.orders ? bad / r.orders : null,
    };
  }).sort((a, b) => {
    const A = a[sort.k], B = b[sort.k];
    if (typeof A === "string" || typeof B === "string") return String(A).localeCompare(String(B)) * sort.dir;
    return ((A ?? -1e9) - (B ?? -1e9)) * sort.dir;
  }), [rows, sort]);

  if (!rows) return <div className="text-sm text-muted-foreground py-10 text-center">加载中…</div>;
  return (
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
          {data.map((x) => (
            <TableRow key={`${x.site}|${x.r.pid}`} tabIndex={0} aria-selected={picked === x.r.pid}
              className="cursor-pointer aria-selected:bg-muted" onClick={() => onPick(x.r.pid)}
              onKeyDown={(e) => { if (e.key === "Enter") onPick(x.r.pid); }}>
              <TableCell>{x.site}</TableCell>
              <TableCell className="max-w-[260px]">
                <div className="truncate" title={x.sku}>{x.sku || "—"}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{x.r.pid}</div>
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
