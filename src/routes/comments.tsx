import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, Languages, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";
import { MultiSelect } from "@/components/MultiSelect";

export const Route = createFileRoute("/comments")({
  head: () => ({ meta: [{ title: "评论内容 - TikTok授权工具" }] }),
  component: CommentsPage,
});

type Row = {
  comment_id: string;
  advertiser_id: string;
  country: string | null;
  vid: string | null;
  text: string | null;
  text_zh: string | null;
  like_count: number;
  reply_count: number;
  username: string | null;
  avatar_url: string | null;
  comment_type: string | null;
  parent_comment_id: string | null;
  comment_create_time: string | null;
};

function CommentsPage() {
  const [rows, setRows] = React.useState<Row[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [kw, setKw] = React.useState("");
  const [fCountry, setFCountry] = React.useState<string[]>([]);
  const [fAdv, setFAdv] = React.useState<string[]>([]);
  const [page, setPage] = React.useState(1);
  const PAGE_SIZE = 50;

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("tiktok_comments" as never)
        .select("comment_id, advertiser_id, country, vid, text, text_zh, like_count, reply_count, username, avatar_url, comment_type, parent_comment_id, comment_create_time")
        .order("comment_create_time", { ascending: false })
        .limit(2000);
      if (error) throw error;
      setRows((data ?? []) as Row[]);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally { setLoading(false); }
  };
  React.useEffect(() => { load(); }, []);

  const countries = React.useMemo(() => Array.from(new Set(rows.map((r) => r.country).filter(Boolean))) as string[], [rows]);
  const advs = React.useMemo(() => Array.from(new Set(rows.map((r) => r.advertiser_id))), [rows]);

  const visible = React.useMemo(() => rows.filter((r) => {
    if (fCountry.length && (!r.country || !fCountry.includes(r.country))) return false;
    if (fAdv.length && !fAdv.includes(r.advertiser_id)) return false;
    if (kw && !(r.text ?? "").toLowerCase().includes(kw.toLowerCase()) && !(r.text_zh ?? "").includes(kw)) return false;
    return true;
  }), [rows, fCountry, fAdv, kw]);
  React.useEffect(() => { setPage(1); }, [fCountry, fAdv, kw]);
  const paged = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));

  const handleSync = async () => {
    setBusy("sync");
    try {
      const r = await invokeFn<{ upserted: number; errors: unknown[] }>("tiktok-comments-sync", {});
      toast.success(`已同步 ${r.upserted} 条评论`);
      await load();
    } catch (e) { toast.error(`同步失败：${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  const handleTranslate = async () => {
    setBusy("tr");
    try {
      const r = await invokeFn<{ translated: number; remaining: number }>("tiktok-comments-translate", { limit: 200 });
      toast.success(`已翻译 ${r.translated} 条，剩余 ${r.remaining} 条`);
      await load();
    } catch (e) { toast.error(`翻译失败：${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">评论内容</h2>
          <p className="text-sm text-muted-foreground mt-1">同步广告户评论并翻译成中文</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSync} disabled={!!busy}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${busy === "sync" ? "animate-spin" : ""}`} />
            同步评论
          </Button>
          <Button variant="outline" onClick={handleTranslate} disabled={!!busy}>
            <Languages className={`h-4 w-4 mr-1.5 ${busy === "tr" ? "animate-spin" : ""}`} />
            翻译未翻译
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="text-base">
            评论列表 <span className="text-xs font-normal text-muted-foreground ml-1">（共 {visible.length} / {rows.length} 条）</span>
          </CardTitle>
          <div className="flex flex-wrap items-end gap-3">
            <MultiSelect label="国家" options={countries} value={fCountry} onChange={setFCountry} />
            <MultiSelect label="广告户" options={advs} value={fAdv} onChange={setFAdv} />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">关键词</span>
              <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索评论文本" className="h-8 w-64" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>国家</TableHead>
                  <TableHead>广告户</TableHead>
                  <TableHead>评论内容</TableHead>
                  <TableHead className="text-right">点赞</TableHead>
                  <TableHead className="text-right">回复</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>父评论ID</TableHead>
                  <TableHead>VID</TableHead>
                  <TableHead>视频</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={11} className="h-20 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
                ) : paged.length === 0 ? (
                  <TableRow><TableCell colSpan={11} className="h-20 text-center text-sm text-muted-foreground">暂无数据，点击「同步评论」</TableCell></TableRow>
                ) : paged.map((r) => (
                  <TableRow key={r.comment_id}>
                    <TableCell>{r.country ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.advertiser_id}</TableCell>
                    <TableCell className="max-w-md">
                      <div className="text-sm">{r.text ?? ""}</div>
                      {r.text_zh && <div className="text-xs text-muted-foreground mt-0.5">{r.text_zh}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.like_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.reply_count}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {r.avatar_url && <img src={r.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
                        <span className="text-xs">{r.username ?? "—"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{r.comment_type ?? "—"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{r.comment_create_time?.slice(0, 19).replace("T", " ") ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.parent_comment_id ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.vid ?? "—"}</TableCell>
                    <TableCell>
                      {r.vid ? (
                        <a href={`https://www.tiktok.com/@tiktok/video/${r.vid}`} target="_blank" rel="noreferrer" className="text-primary hover:underline text-xs">打开</a>
                      ) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {visible.length > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
              <div>第 {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, visible.length)} / 共 {visible.length} 条</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
                <span>{page} / {pageCount}</span>
                <Button size="sm" variant="outline" className="h-7" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
