import * as React from "react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { reviewsApi, type ListItem } from "@/lib/reviewsApi";
import { Thumbs } from "./ImageViewer";
import { Help, ListingLabel, Pager, STAR_COLORS, useFitRows } from "./shared";

type Props = { ver: number; active: boolean; sites: string[]; from: string; to: string; q: string; onPick: (pid: string) => void };
const STAR_OPTS: Record<string, number[]> = { bad: [1, 2], s3: [3], good: [4, 5], all: [] };
type SortK = "ts" | "sku" | "star";

/**
 * 评论内容：有内容的评价（抓取表）按列展示，可按时间 / SKU / 星级排序；默认只看 1–2★。
 * 抓取截止日之后接口新增、还没有内容的评价也是一行（按 日期 × 链接 × 星级），内容列显示「待导入评论」。
 */
export function CommentsView({ ver, active, sites, from, to, q, onPick }: Props) {
  const [opt, setOpt] = React.useState("bad");
  const [sort, setSort] = React.useState<{ k: SortK; desc: boolean }>({ k: "ts", desc: true });
  const [page, setPage] = React.useState(0);
  const [data, setData] = React.useState<{ total: number; rows: ListItem[] } | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const per = useFitRows(boxRef, 58, 120);
  React.useEffect(() => setPage(0), [sites, from, to, q, opt, per, sort]);

  // 只在本 TAB 可见时取数；同一条件的结果缓存；取新数据时保留旧内容
  const cache = React.useRef(new Map<string, { total: number; rows: ListItem[] }>());
  React.useEffect(() => {
    if (!active) return;
    const key = JSON.stringify([ver, sites, from, to, q, opt, per, page, sort]);
    const hit = cache.current.get(key);
    if (hit) { setData(hit); return; }
    let stale = false;
    reviewsApi.list({ sites, from, to, q }, STAR_OPTS[opt], per, page * per, sort.k, sort.desc)
      .then((r) => { cache.current.set(key, r); if (!stale) setData(r); }).catch((e) => toast.error((e as Error).message));
    return () => { stale = true; };
  }, [ver, active, sites, from, to, q, opt, per, page, sort]);

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / per));
  const th = (k: SortK, label: string, cls = "") => (
    <TableHead className={cls} aria-sort={sort.k === k ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="hover:text-foreground" onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k !== "sku" }))}>
        {label}{sort.k === k ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </TableHead>
  );
  const two = (a: string | null, b: string | null) => (
    <div className="min-w-0" title={[a, b].filter(Boolean).join("\n")}>
      {a ? <div className="line-clamp-2 break-words">{a}</div> : <span className="text-muted-foreground">—</span>}
      {b && <div className="line-clamp-1 break-words text-xs text-muted-foreground">{b}</div>}
    </div>
  );

  return (
    <div ref={boxRef} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" size="sm" variant="outline" value={opt} onValueChange={(v) => v && setOpt(v)} aria-label="星级">
          <ToggleGroupItem value="bad">1–2★</ToggleGroupItem>
          <ToggleGroupItem value="s3">3★</ToggleGroupItem>
          <ToggleGroupItem value="good">4–5★</ToggleGroupItem>
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
        </ToggleGroup>
        <Help label="评论内容说明" text="正文来自上传的抓取表（只有带留言或回复的评价）；原文下面一行是中文译文。「待导入评论」= 抓取截止日之后接口新增的评价，还没有内容，×N 为条数。悬停看全文，点图片放大，点 SKU 看该链接趋势。" />
        <div className="ml-auto"><Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} /></div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table className="table-fixed text-sm">
          <colgroup>
            <col className="w-[112px]" /><col className="w-[220px]" /><col className="w-[60px]" /><col /><col /><col className="w-[148px]" />
          </colgroup>
          <TableHeader>
            <TableRow>
              {th("ts", "评论时间")}
              {th("sku", "SKU")}
              {th("star", "星级")}
              <TableHead>评论内容</TableHead>
              <TableHead>回复内容</TableHead>
              <TableHead>图片</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">加载中…</TableCell></TableRow>}
            {data?.rows.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">没有评价</TableCell></TableRow>}
            {data?.rows.map((r, i) => (
              <TableRow key={r.review_id ?? `g${i}`} className={`align-top ${r.kind === "gap" ? "text-muted-foreground" : ""}`}>
                <TableCell className="tabular-nums text-xs">
                  <div>{r.kind === "gap" && r.init ? "首次同步前" : r.ts?.slice(0, 10)}</div>
                  <div className="text-muted-foreground">{r.kind === "gap" ? "" : `${r.ts?.slice(11, 16)} · `}{r.shop_key}</div>
                </TableCell>
                <TableCell>
                  <button type="button" className="w-full text-left hover:underline" onClick={() => onPick(r.product_id)}>
                    <ListingLabel sku={r.sku} title={r.title} pid={r.product_id} showPid={false} />
                  </button>
                  {r.order_id && <div className="truncate font-mono text-[11px] text-muted-foreground" title={`订单 ${r.order_id}`}>{r.order_id}</div>}
                </TableCell>
                <TableCell className="font-semibold tabular-nums" style={{ color: STAR_COLORS[r.star - 1] }}>{r.star}★{r.kind === "gap" && r.cnt > 1 && <span className="ml-0.5 text-xs font-normal">×{r.cnt}</span>}</TableCell>
                <TableCell>{r.kind === "gap" ? <span className="text-muted-foreground">待导入评论</span> : two(r.content, r.content_zh)}</TableCell>
                <TableCell>{two(r.reply, r.reply_zh)}</TableCell>
                <TableCell><Thumbs imgs={r.imgs} count={r.img_count} max={3} size={36} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
