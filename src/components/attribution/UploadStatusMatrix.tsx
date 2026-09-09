// 上传状态矩阵：行=月份（新→旧），列=站点，格子=该站点该月的上传/归因状态。
import * as React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { UploadRec } from "@/lib/attributionApi";

type CellStatus = "READY" | "PARTIAL" | "UPLOADING" | "FAILED" | "EMPTY";

const STATUS_LABEL: Record<CellStatus, string> = {
  READY: "已归因",
  PARTIAL: "部分归因",
  UPLOADING: "上传中",
  FAILED: "失败",
  EMPTY: "无数据",
};

const STATUS_CLASS: Record<CellStatus, string> = {
  READY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  PARTIAL: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  UPLOADING: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  EMPTY: "text-muted-foreground",
};

function cellStatus(rows: UploadRec[]): CellStatus {
  if (!rows.length) return "EMPTY";
  const readyCount = rows.filter((r) => r.status === "READY").length;
  if (readyCount === rows.length) return "READY";
  if (readyCount > 0) return "PARTIAL";
  if (rows.some((r) => r.status === "UPLOADING")) return "UPLOADING";
  return "FAILED";
}

export function UploadStatusMatrix({ history }: { history: UploadRec[] }) {
  const { countries, months, byKey } = React.useMemo(() => {
    const countrySet = new Set<string>();
    const monthSet = new Set<string>();
    const map = new Map<string, UploadRec[]>();
    for (const u of history) {
      countrySet.add(u.country);
      monthSet.add(u.month);
      const key = `${u.country}|${u.month}`;
      const arr = map.get(key) ?? [];
      arr.push(u);
      map.set(key, arr);
    }
    return {
      countries: Array.from(countrySet).sort(),
      months: Array.from(monthSet).sort((a, b) => b.localeCompare(a)),
      byKey: map,
    };
  }, [history]);

  if (!history.length) {
    return <div className="text-sm text-muted-foreground text-center py-16">暂无上传记录</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(STATUS_LABEL) as CellStatus[]).filter((s) => s !== "EMPTY").map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={`inline-block h-3 w-3 rounded-sm ${STATUS_CLASS[s]}`} />{STATUS_LABEL[s]}
          </span>
        ))}
      </div>
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background">月份</TableHead>
              {countries.map((c) => <TableHead key={c} className="text-center whitespace-nowrap">{c}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((m) => (
              <TableRow key={m}>
                <TableCell className="sticky left-0 bg-background text-xs tabular-nums font-medium">{m}</TableCell>
                {countries.map((c) => {
                  const rows = byKey.get(`${c}|${m}`) ?? [];
                  const status = cellStatus(rows);
                  const title = rows.length
                    ? rows.map((r) => `${r.file_name}：${r.status}${r.row_count ? `（${r.row_count}行）` : ""}`).join("\n")
                    : "无数据";
                  return (
                    <TableCell key={c} className="text-center p-1">
                      <span
                        title={title}
                        className={`inline-block w-full rounded px-1.5 py-1 text-[11px] whitespace-nowrap ${STATUS_CLASS[status]}`}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
