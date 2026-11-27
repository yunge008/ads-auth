import * as React from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** 评价图放大：当前页面弹层显示，左右按钮 / 键盘 ← → / 手指左右滑切换，不新开页签 */
export function ImageViewer({ imgs, index, onClose }: { imgs: [string, string][]; index: number | null; onClose: () => void }) {
  const [i, setI] = React.useState(index ?? 0);
  React.useEffect(() => { if (index != null) setI(index); }, [index]);
  const n = imgs.length;
  const go = React.useCallback((d: number) => setI((x) => (x + d + n) % n), [n]);
  const touchX = React.useRef<number | null>(null);
  return (
    <Dialog open={index != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-[92vw] w-auto border-0 bg-black/90 p-2 sm:max-w-[92vw] [&>button]:hidden"
        onKeyDown={(e) => { if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); }}
        onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touchX.current == null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}>
        <DialogTitle className="sr-only">评价图 {i + 1} / {n}</DialogTitle>
        <div className="relative flex items-center justify-center">
          {n > 0 && <img src={imgs[i][1]} referrerPolicy="no-referrer" alt={`评价图 ${i + 1}`} className="max-h-[84vh] max-w-[88vw] object-contain" />}
          {n > 1 && (
            <>
              <button type="button" aria-label="上一张" onClick={() => go(-1)} className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 text-black hover:bg-white"><ChevronLeft className="h-5 w-5" /></button>
              <button type="button" aria-label="下一张" onClick={() => go(1)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 text-black hover:bg-white"><ChevronRight className="h-5 w-5" /></button>
            </>
          )}
          <button type="button" aria-label="关闭" onClick={onClose} className="absolute right-1 top-1 rounded-full bg-white/80 p-1.5 text-black hover:bg-white"><X className="h-4 w-4" /></button>
          {n > 1 && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-xs text-white tabular-nums">{i + 1} / {n}</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 缩略图条：点哪张从哪张开始看 */
export function Thumbs({ imgs, count = 0, max = 3, size = 40 }: { imgs: [string, string][] | null; count?: number; max?: number; size?: number }) {
  const [open, setOpen] = React.useState<number | null>(null);
  const list = imgs ?? [];
  if (!list.length) return count > 0 ? <span className="text-xs text-muted-foreground">{count} 图</span> : null;
  return (
    <div className="flex items-center gap-1">
      {list.slice(0, max).map(([thumb], k) => (
        <button key={k} type="button" onClick={(e) => { e.stopPropagation(); setOpen(k); }} aria-label={`查看评价图 ${k + 1}`} className="shrink-0">
          <img src={thumb} referrerPolicy="no-referrer" loading="lazy" alt="" style={{ width: size, height: size }} className="rounded border bg-muted object-cover" />
        </button>
      ))}
      {list.length > max && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(max); }} className="text-xs text-muted-foreground hover:text-foreground">+{list.length - max}</button>
      )}
      <ImageViewer imgs={list} index={open} onClose={() => setOpen(null)} />
    </div>
  );
}
