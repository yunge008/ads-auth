import * as React from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { addS, avgS, sumS, ZERO, type ReviewText, type Series, type Stars } from "@/lib/reviewsApi";
import { addDays, f2, Help, pct, STAR_COLORS } from "./shared";
import { ReviewItem } from "./ReviewItem";

type Props = { series: Series | null; from: string; to: string; texts: ReviewText[] | null; onStars: (s: number[]) => void; stars: number[] };

/** series 覆盖 [from − 区间长度, to]：前半段算「上期」，后半段是本期 */
export function TrendView({ series, from, to, texts, onStars, stars }: Props) {
  const [mode, setMode] = React.useState<"cum" | "day">("cum");
  const calc = React.useMemo(() => {
    if (!series) return null;
    const byDay = new Map(series.days.map((d) => [d.d, d]));
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
    const prevFrom = addDays(from, -span);
    let cum: Stars = series.base;
    let prev: Stars = ZERO, cur: Stars = ZERO, curOrders = 0, prevOrders = 0;
    let cumAtFrom: Stars = ZERO;
    const rows: { d: string; s: Stars; orders: number; cumAvg: number | null; dayAvg: number | null; n: number; bad: number | null }[] = [];
    for (let d = prevFrom; d <= to; d = addDays(d, 1)) {
      const x = byDay.get(d);
      const s: Stars = x ? [x.s1, x.s2, x.s3, x.s4, x.s5] : ZERO;
      const init: Stars = x ? [x.i1, x.i2, x.i3, x.i4, x.i5] : ZERO;
      if (d === from) cumAtFrom = cum;
      cum = addS(addS(cum, s), init);
      if (d < from) { prev = addS(prev, s); prevOrders += x?.orders ?? 0; continue; }
      cur = addS(cur, s);
      curOrders += x?.orders ?? 0;
      const n = sumS(s);
      rows.push({ d, s, orders: x?.orders ?? 0, cumAvg: avgS(cum), dayAvg: avgS(s), n, bad: n ? (s[0] + s[1]) / n : null });
    }
    return { rows, cur, prev, cumEnd: cum, cumAtFrom, curOrders, prevOrders };
  }, [series, from, to]);

  if (!calc) return <div className="text-sm text-muted-foreground py-10 text-center">加载中…</div>;
  const n = sumS(calc.cur), pn = sumS(calc.prev);
  const bad = n ? (calc.cur[0] + calc.cur[1]) / n : null, pbad = pn ? (calc.prev[0] + calc.prev[1]) / pn : null;
  const kpis = [
    { label: "评价数", v: n.toLocaleString(), d: n - pn, fmt: (x: number) => Math.round(x).toLocaleString(), good: true },
    { label: "区间平均分", help: ["区间内评价按条数加权平均", "不是每日平均分再平均"], v: f2(avgS(calc.cur)), d: diff(avgS(calc.cur), avgS(calc.prev)), fmt: (x: number) => x.toFixed(2), good: true },
    { label: "累计平均分", help: ["截至结束日全部评价的加权平均", "= listing 当天显示分", "变化 = 区间内的变化"], v: f2(avgS(calc.cumEnd)), d: diff(avgS(calc.cumEnd), avgS(calc.cumAtFrom)), fmt: (x: number) => x.toFixed(3), good: true, inRange: true },
    { label: "差评率", help: ["1–2 星条数 ÷ 区间评价数"], v: pct(bad), d: diff(bad, pbad), fmt: (x: number) => `${(x * 100).toFixed(1)}pp`, good: false },
  ];
  const cumVals = calc.rows.map((r) => r.cumAvg).filter((v): v is number => v != null);
  // 纵轴贴着数据走，小变化也看得出：上下各留 25% 余量，最少 ±0.005
  const cMin = cumVals.length ? Math.min(...cumVals) : 4, cMax = cumVals.length ? Math.max(...cumVals) : 5;
  const pad = Math.max(0.005, (cMax - cMin) * 0.25);
  const lo = Math.max(1, Math.floor((cMin - pad) * 1000) / 1000);
  const hi = Math.min(5, Math.ceil((cMax + pad) * 1000) / 1000);
  const cumDigits = hi - lo < 0.1 ? 3 : 2;
  // 差评率右轴：默认 3% 封顶，超过时按最大值向上取整
  const badMax = Math.max(3, Math.ceil(Math.max(0, ...calc.rows.map((r) => (r.bad ?? 0) * 100))));
  const maxN = Math.max(1, ...calc.rows.map((r) => r.n));
  const tick = { fontSize: 11, fill: "var(--muted-foreground)" };

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <Card key={k.label}><CardContent className="p-3 grid gap-0.5">
            <span className="text-xs text-muted-foreground flex items-center gap-1">{k.label}{k.help && <Help text={k.help} label={`${k.label}口径`} />}</span>
            <span className="text-2xl font-semibold tabular-nums">{k.v}</span>
            <Delta d={k.d} fmt={k.fmt} good={k.good} prefix={k.inRange ? "区间内" : "较上期"} />
          </CardContent></Card>
        ))}
      </div>

      <Card><CardContent className="p-3 grid gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">评分走势</h3>
          <Help label="评分走势口径" text={["累计平均分：截至当天全部评价 = 当天显示分", "当日平均分：当天新增评价的平均分", "当天无评价留空；点越大条数越多"]} />
          <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as "cum" | "day")} className="ml-auto" aria-label="走势口径">
            <ToggleGroupItem value="cum">累计平均分</ToggleGroupItem>
            <ToggleGroupItem value="day">当日平均分</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={calc.rows} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="d" tick={tick} tickLine={false} axisLine={false} minTickGap={40} />
              {mode === "cum" ? (
                <YAxis domain={[lo, hi]} tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => Number(v).toFixed(cumDigits)} width={52} />
              ) : (
                <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={tick} tickLine={false} axisLine={false} />
              )}
              <RTooltip formatter={(v: number, _k, p) => (mode === "cum" ? [Number(v).toFixed(3), "累计平均分"] : [`${f2(v)} · ${(p.payload as { n: number }).n} 条`, "当日平均分"])} labelClassName="text-xs" contentStyle={{ fontSize: 12 }} />
              {mode === "cum" ? (
                <Line dataKey="cumAvg" stroke="#2563eb" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              ) : (
                <Line dataKey="dayAvg" stroke="var(--muted-foreground)" strokeOpacity={0.35} strokeWidth={1} isAnimationActive={false} connectNulls={false}
                  dot={(p: { cx?: number; cy?: number; payload: { n: number; dayAvg: number | null }; index: number }) => {
                    if (p.payload.dayAvg == null || p.cx == null || p.cy == null) return <g key={p.index} />;
                    const v = p.payload.dayAvg;
                    return <circle key={p.index} cx={p.cx} cy={p.cy} r={2 + 5 * Math.sqrt(p.payload.n / maxN)} fill={STAR_COLORS[v >= 4.5 ? 4 : v >= 4 ? 3 : v >= 3 ? 2 : 0]} />;
                  }} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent></Card>

      <Card><CardContent className="p-3 grid gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">每日评价数</h3>
          <Help label="每日评价数说明" text={["柱（左轴）：当天新增条数，按星级堆叠", "线（右轴）：当天差评率（1–2 星占比）", "右轴默认 3% 封顶，超出自动放大"]} />
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={calc.rows.map((r) => ({ d: r.d, s5: r.s[4], s4: r.s[3], s3: r.s[2], s2: r.s[1], s1: r.s[0], bad: r.bad == null ? null : r.bad * 100 }))} margin={{ top: 4, right: 0, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="d" tick={tick} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis yAxisId="n" allowDecimals={false} tick={tick} tickLine={false} axisLine={false} />
              <YAxis yAxisId="r" orientation="right" domain={[0, badMax]} allowDataOverflow tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => `${Number(v).toFixed(badMax < 10 ? 1 : 0)}%`} />
              <RTooltip contentStyle={{ fontSize: 12 }} formatter={(v: number, k: string) => (k === "差评率" ? [`${Number(v).toFixed(1)}%`, k] : [v, k])} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              {[5, 4, 3, 2, 1].map((s) => <Bar key={s} yAxisId="n" dataKey={`s${s}`} name={`${s}★`} stackId="a" fill={STAR_COLORS[s - 1]} isAnimationActive={false} />)}
              <Line yAxisId="r" dataKey="bad" name="差评率" stroke="#dc2626" strokeWidth={1.5} dot={{ r: 2, fill: "#dc2626" }} connectNulls={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent></Card>

      {texts && (
        <Card><CardContent className="p-3 grid gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">评价内容</h3>
            <span className="text-xs text-muted-foreground tabular-nums">{texts.length}</span>
            <ToggleGroup type="single" size="sm" variant="outline" className="ml-auto" aria-label="星级筛选"
              value={stars.length === 0 ? "all" : stars.join("")} onValueChange={(v) => onStars(v === "12" ? [1, 2] : v === "3" ? [3] : v === "45" ? [4, 5] : [])}>
              <ToggleGroupItem value="all">全部</ToggleGroupItem>
              <ToggleGroupItem value="12">1–2★</ToggleGroupItem>
              <ToggleGroupItem value="3">3★</ToggleGroupItem>
              <ToggleGroupItem value="45">4–5★</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="max-h-[420px] overflow-auto divide-y">
            {texts.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">区间内没有留言</div>}
            {texts.map((t) => (
              <ReviewItem key={t.review_id} r={t} meta={<>{t.review_at?.slice(0, 16).replace("T", " ")} · {t.seller_sku ?? ""} · 订单 {t.order_id ?? "—"}</>} />
            ))}
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}

const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);
function Delta({ d, fmt, good, prefix }: { d: number | null; fmt: (x: number) => string; good: boolean; prefix: string }) {
  if (d == null) return <span className="text-xs text-muted-foreground">上期无数据</span>;
  const flat = Math.abs(d) < 1e-9;
  const cls = flat ? "text-muted-foreground" : (d > 0) === good ? "text-green-600" : "text-red-600";
  return <span className={`text-xs tabular-nums ${cls}`}>{prefix} {d > 0 ? "+" : ""}{fmt(d)}</span>;
}
