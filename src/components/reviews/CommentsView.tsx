import * as React from "react";
import { toast } from "sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { reviewsApi, type ListItem } from "@/lib/reviewsApi";
import { ReviewItem } from "./ReviewItem";
import { Help, Pager, STAR_COLORS, useFitRows } from "./shared";

type Props = { sites: string[]; from: string; to: string; q: string; onPick: (pid: string) => void };
const STAR_OPTS: Record<string, number[]> = { bad: [1, 2], s3: [3], good: [4, 5], all: [] };

/** 评论内容：按时间倒序；默认只看差评（1–2★）；抓取截止日之后接口新增但没有内容的评价显示为占位 */
export function CommentsView({ sites, from, to, q, onPick }: Props) {
  const [opt, setOpt] = React.useState("bad");
  const [page, setPage] = React.useState(0);
  const [data, setData] = React.useState<{ total: number; rows: ListItem[] } | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const per = useFitRows(boxRef, 92, 70);
  React.useEffect(() => setPage(0), [sites, from, to, q, opt, per]);
  React.useEffect(() => {
    let stale = false;
    setData(null);
    reviewsApi.list({ sites, from, to, q }, STAR_OPTS[opt], per, page * per)
      .then((r) => { if (!stale) setData(r); }).catch((e) => toast.error((e as Error).message));
    return () => { stale = true; };
  }, [sites, from, to, q, opt, per, page]);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / per));

  return (
    <div ref={boxRef} className="grid gap-2">
      <div className="flex items-center gap-2">
        <ToggleGroup type="single" size="sm" variant="outline" value={opt} onValueChange={(v) => v && setOpt(v)} aria-label="星级">
          <ToggleGroupItem value="bad">1–2★</ToggleGroupItem>
          <ToggleGroupItem value="s3">3★</ToggleGroupItem>
          <ToggleGroupItem value="good">4–5★</ToggleGroupItem>
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
        </ToggleGroup>
        <Help label="评论内容说明" text="只列有留言或有回复的评价（来自上传的抓取表）。灰色虚线行 = 抓取截止日之后接口发现的新评价，还没有内容，下次上传抓取表后会变成正文；「首次同步前」表示那几天的评价是一笔合计，日期不详。点商品 ID 看该链接的趋势。" />
        <div className="ml-auto"><Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} /></div>
      </div>
      <div className="rounded-md border px-3 divide-y">
        {!data && <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>}
        {data?.rows.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">没有评价</div>}
        {data?.rows.map((r, i) => {
          const meta = (
            <>
              {r.ts?.slice(0, 16).replace("T", " ")} · {r.shop_key} ·{" "}
              <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => onPick(r.product_id)}>{r.product_id}</button>
              {r.sku && <span title={r.sku}> · {r.sku.length > 40 ? `${r.sku.slice(0, 40)}…` : r.sku}</span>}
              {r.order_id && <> · 订单 {r.order_id}</>}
            </>
          );
          if (r.kind === "gap") {
            const c = r.counts ?? [0, 0, 0, 0, 0];
            return (
              <div key={`g${i}`} className="my-1 rounded border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <span>{r.init ? "首次同步前新增（日期不详）" : "接口新增"} </span>
                {[0, 1, 2, 3, 4].filter((k) => c[k] > 0).map((k) => (
                  <span key={k} className="mr-2 tabular-nums" style={{ color: STAR_COLORS[k] }}>{k + 1}★×{c[k]}</span>
                ))}
                <span>，内容待上传</span>
                <div className="text-xs mt-0.5">{meta}</div>
              </div>
            );
          }
          return <ReviewItem key={`t${i}`} r={r} meta={meta} />;
        })}
      </div>
    </div>
  );
}
