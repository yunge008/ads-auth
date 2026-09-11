// 内容类型占比：商品卡 / 直播 / 视频 / 其他 在各站点的 GMV 分布。
// 所有行都入库，只是分类不同 —— 商品卡和「其他」不归人，但金额照样统计，
// 想看「整个国家的 GMV 各自占多少」就看这里。
import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type TypeMixRow, fmtUsd, fmtPct } from "@/lib/attributionApi";

/** 展示顺序固定，缺的类型也占位，方便横向比对。 */
const TYPE_ORDER = ["video", "live", "product_card", "other"] as const;
const TYPE_LABELS: Record<string, string> = {
  video: "视频",
  live: "直播",
  product_card: "商品卡",
  other: "其他",
};

export function TypeMixPanel({ rows }: { rows: TypeMixRow[] }) {
  const { countries, cellGmv, typeTotal, grand } = React.useMemo(() => {
    const cellGmv = new Map<string, number>();
    const typeTotal = new Map<string, number>();
    const countrySet = new Set<string>();
    let grand = 0;
    for (const r of rows) {
      const country = r.country || "未知站点";
      const type = TYPE_ORDER.includes(r.creative_type as (typeof TYPE_ORDER)[number]) ? r.creative_type : "other";
      countrySet.add(country);
      cellGmv.set(`${country}|${type}`, (cellGmv.get(`${country}|${type}`) ?? 0) + r.gmv);
      typeTotal.set(type, (typeTotal.get(type) ?? 0) + r.gmv);
      grand += r.gmv;
    }
    // 按 GMV 降序排站点，大盘在最上面
    const byCountry = new Map<string, number>();
    for (const [k, v] of cellGmv) {
      const country = k.split("|")[0];
      byCountry.set(country, (byCountry.get(country) ?? 0) + v);
    }
    const countries = Array.from(countrySet).sort((a, b) => (byCountry.get(b) ?? 0) - (byCountry.get(a) ?? 0));
    return { countries, cellGmv, typeTotal, grand };
  }, [rows]);

  if (!rows.length) return null;

  const countryTotal = (c: string) => TYPE_ORDER.reduce((n, t) => n + (cellGmv.get(`${c}|${t}`) ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">内容类型占比</CardTitle>
        <p className="text-xs text-muted-foreground">
          广告表的每一行都入库，只是分类不同：视频按 VID + 达人昵称归因、直播只按达人昵称归 BD、
          商品卡与其他不归人但金额照样统计。下表是各站点的 GMV（USD）分布，括号内为该站点内部占比。
        </p>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background whitespace-nowrap">站点</TableHead>
                <TableHead className="text-right whitespace-nowrap">合计 GMV</TableHead>
                {TYPE_ORDER.map((t) => (
                  <TableHead key={t} className="text-right whitespace-nowrap">{TYPE_LABELS[t]}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {countries.map((c) => {
                const total = countryTotal(c);
                return (
                  <TableRow key={c}>
                    <TableCell className="sticky left-0 bg-background font-medium whitespace-nowrap">{c}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">${fmtUsd(total)}</TableCell>
                    {TYPE_ORDER.map((t) => {
                      const v = cellGmv.get(`${c}|${t}`) ?? 0;
                      return (
                        <TableCell key={t} className="text-right tabular-nums text-xs whitespace-nowrap">
                          <div>${fmtUsd(v)}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {total > 0 ? fmtPct(v / total) : "—"}
                          </div>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
              <TableRow className="font-medium">
                <TableCell className="sticky left-0 bg-background">全部站点</TableCell>
                <TableCell className="text-right tabular-nums">${fmtUsd(grand)}</TableCell>
                {TYPE_ORDER.map((t) => {
                  const v = typeTotal.get(t) ?? 0;
                  return (
                    <TableCell key={t} className="text-right tabular-nums text-xs whitespace-nowrap">
                      <div>${fmtUsd(v)}</div>
                      <div className="text-[11px] text-muted-foreground">{grand > 0 ? fmtPct(v / grand) : "—"}</div>
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
