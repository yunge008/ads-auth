import { STAR_COLORS } from "./shared";

type Text = {
  star: number | null; ts?: string | null; review_at?: string | null; content: string | null; content_zh: string | null;
  reply: string | null; reply_zh: string | null; order_id: string | null; img_count: number; imgs: [string, string][] | null;
};

/** 一条评价：左星级，中间原文 / 中文 / 回复 / 元信息，右侧评价图缩略图（点开原图） */
export function ReviewItem({ r, meta }: { r: Text; meta: React.ReactNode }) {
  const star = r.star ?? 0;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-2 text-sm">
      <span className="font-semibold tabular-nums" style={{ color: STAR_COLORS[star - 1] }}>{star}★</span>
      <div className="grid gap-0.5 min-w-0">
        {r.content && <div className="break-words">{r.content}</div>}
        {r.content_zh && <div className="text-muted-foreground break-words">{r.content_zh}</div>}
        {r.reply && (
          <div className="border-l-2 pl-2 text-muted-foreground break-words">
            回复：{r.reply}{r.reply_zh && <div>{r.reply_zh}</div>}
          </div>
        )}
        <div className="text-xs text-muted-foreground tabular-nums">{meta}</div>
      </div>
      <div className="flex flex-wrap justify-end gap-1 max-w-[260px]">
        {(r.imgs ?? []).slice(0, 4).map(([thumb, url], i) => (
          <a key={i} href={url} target="_blank" rel="noreferrer noopener" aria-label={`评价图 ${i + 1}，在新窗口打开原图`}>
            <img src={thumb} referrerPolicy="no-referrer" loading="lazy" alt="" className="h-14 w-14 rounded object-cover border bg-muted" />
          </a>
        ))}
        {(r.imgs?.length ?? 0) > 4 && <span className="self-end text-xs text-muted-foreground">+{r.imgs!.length - 4}</span>}
        {!r.imgs?.length && r.img_count > 0 && <span className="self-start text-xs text-muted-foreground">{r.img_count} 图</span>}
      </div>
    </div>
  );
}
