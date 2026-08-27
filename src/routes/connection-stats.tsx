import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateCw, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { invokeFn } from "@/lib/api";

export const Route = createFileRoute("/connection-stats")({
  head: () => ({ meta: [{ title: "发样及素材统计 - TikTok授权工具" }] }),
  component: ConnectionStatsPage,
});

// ---------- types ----------
type GroupedRow = {
  staff_name: string; role: "BD" | "EDITOR"; country: string; sku: string;
  samples: number | null; recovered: number; rate: number | null;
};
type CountryPieItem = { country: string; count: number };
type TierPieItem = { tier: string; count: number };
type DailyPoint = {
  date: string; sample: number; recover: number; rate: number | null;
  by_staff: Record<string, { sample: number; recover: number }>;
};
type QueryResp = {
  countries: string[] | null;
  staff: { bd: string[]; editor: string[] } | null;
  summary: {
    bd_sample_total: number; bd_recover_total: number; bd_recover_rate: number | null;
    bd_daily_avg_recover: number | null; editor_output_total: number; editor_daily_avg_output: number | null;
    equivalent_days: number;
  };
  grouped_rows: GroupedRow[];
  country_pie: { sample: CountryPieItem[]; sample_total: number; recover: CountryPieItem[]; recover_total: number };
  fan_tier_pie: {
    sample: TierPieItem[]; sample_total: number; sample_by_country: Record<string, TierPieItem[]>;
    recover: TierPieItem[]; recover_total: number; recover_by_country: Record<string, TierPieItem[]>;
    thresholds: Record<string, { 其他: string; MX: string }>;
  };
  daily_series: DailyPoint[];
  last_synced_at: string | null;
};

const TIER_COLOR: Record<string, string> = {
  大: "oklch(0.42 0.13 250)", 中: "oklch(0.53 0.12 250)", 中小: "oklch(0.65 0.10 250)",
  小: "oklch(0.76 0.07 250)", 特小: "oklch(0.86 0.04 250)",
};
const TIERS = ["大", "中", "中小", "小", "特小"];
// Golden-angle hue steps: never repeats or clusters two nearby indices on a similar hue,
// unlike a short fixed palette that wraps (and collides) once the item count exceeds it.
const paletteColor = (i: number) => `oklch(0.62 0.13 ${(((i * 137.508) % 360) + 360) % 360})`;
function hashIndex(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 997;
}
const C_SEND = "oklch(0.80 0.075 245)";
const C_REC = "oklch(0.42 0.115 253)";
const C_LINE = "oklch(0.66 0.16 55)";
const PERSON_LINE = "oklch(0.80 0.11 62)";
const QUICK_DAYS = [7, 15, 30, 60];

const fmtNum = (n: number) => (n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
const fmtPct = (n: number | null) => (n == null ? "—" : (n * 100).toFixed(1) + "%");

function donutSlices(items: { value: number; color: string }[], total: number, r = 46, sw = 50) {
  const C = 2 * Math.PI * r;
  let acc = 0;
  return items.map((it) => {
    const frac = total ? it.value / total : 0;
    const len = Math.max(0, frac * C - (frac > 0.015 ? 1.6 : 0));
    const s = { r, sw, color: it.color, dash: `${len} ${C - len}`, offset: -acc * C };
    acc += frac;
    return s;
  });
}

function todayIso() { return new Date().toISOString().slice(0, 10); }
function agoIso(days: number) { return new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10); }

// Flex-row "table" column layout, shared by header/body/footer so widths stay in sync.
const COL_DETAIL = [
  { key: "staff_name", label: "人员", flex: 1.15, align: "left" as const },
  { key: "country", label: "国家", flex: 0.8, align: "left" as const },
  { key: "sku", label: "SKU", flex: 1.4, align: "left" as const },
  { key: "samples", label: "发样数量", flex: 0.9, align: "right" as const },
  { key: "recovered", label: "回收素材", flex: 0.9, align: "right" as const },
  { key: "rate", label: "素材回收率", flex: 1.6, align: "right" as const },
];
const COL_SUMMARY = [
  { key: "staff_name", label: "人员", flex: 1.3, align: "left" as const },
  { key: "samples", label: "发样数量", flex: 1, align: "right" as const },
  { key: "recovered", label: "回收素材", flex: 1, align: "right" as const },
  { key: "rate", label: "素材回收率", flex: 1.8, align: "right" as const },
];

function SortTH({
  k, label, align, sortKey, sortDir, onSort,
}: {
  k: string; label: string; align: "left" | "right";
  sortKey: string | null; sortDir: "asc" | "desc"; onSort: (k: string) => void;
}) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`inline-flex items-center gap-1 hover:text-foreground w-full ${active ? "text-foreground font-medium" : "text-muted-foreground"} ${align === "right" ? "flex-row-reverse" : ""}`}
    >
      <span>{label}</span>
      <Icon className={`h-3 w-3 flex-none ${active ? "opacity-100" : "opacity-40"}`} />
    </button>
  );
}

function Pill({ on, color, onClick, children, strong }: { on: boolean; color?: string; onClick: () => void; children: React.ReactNode; strong?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2.5 py-1 rounded-md border whitespace-nowrap transition-colors flex-none"
      style={{
        border: `${strong ? 2 : 1}px solid ${on ? "transparent" : strong ? "#000" : "rgba(0,0,0,.14)"}`,
        background: on ? (color ?? "#1b1a18") : "transparent",
        color: on ? "#fff" : strong ? "#000" : "rgba(0,0,0,.7)",
        fontWeight: strong ? 700 : 400,
      }}
    >
      {children}
    </button>
  );
}

function ConnectionStatsPage() {
  const [from, setFrom] = React.useState(agoIso(29));
  const [to, setTo] = React.useState(todayIso());
  const [selStaff, setSelStaff] = React.useState<string[]>([]);
  const [selCountry, setSelCountry] = React.useState<string[]>([]);
  const [detail, setDetail] = React.useState(true);
  const [metric, setMetric] = React.useState<"发样达人" | "回收素材">("发样达人");
  const [pieCountryDrill, setPieCountryDrill] = React.useState<string | null>(null);
  const [highlightStaff, setHighlightStaff] = React.useState<string | null>(null);
  const [sortKey, setSortKey] = React.useState<string>("recovered");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [hover, setHover] = React.useState<{ i: number; px: number; py: number; flip: boolean } | null>(null);

  const [data, setData] = React.useState<QueryResp | null>(null);
  // Stable filter-option lists (country/staff dropdown), fetched once and kept across later
  // filter-change queries — the query function skips re-scanning them when include_meta=false,
  // which is most of the perceived "click a filter -> feels slow" cost at this row count.
  const [meta, setMeta] = React.useState<{ countries: string[]; staff: { bd: string[]; editor: string[] } } | null>(null);
  const metaLoadedRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  const runQuery = React.useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const r = await invokeFn<QueryResp>("connection-stats-query", {
        start_date: from, end_date: to,
        countries: selCountry.length ? selCountry : undefined,
        staff_names: selStaff.length ? selStaff : undefined,
        detail,
        include_meta: !metaLoadedRef.current,
      }, { signal: controller.signal });
      setData(r);
      if (r.countries && r.staff) {
        metaLoadedRef.current = true;
        setMeta({ countries: r.countries, staff: r.staff });
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      toast.error(`查询失败：${(e as Error).message}`);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [from, to, selCountry, selStaff, detail]);

  React.useEffect(() => { runQuery(); }, [runQuery]);

  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await invokeFn<{ inserted: number; sheets_synced: number; missing_sheets: string[] }>("feishu-read-connection-stats", {});
      toast.success(`同步完成：写入 ${r.inserted} 行 / ${r.sheets_synced} 张表${r.missing_sheets?.length ? `（缺失：${r.missing_sheets.join("、")}）` : ""}`);
      metaLoadedRef.current = false; // pull fresh country/staff lists once after a real re-sync
      await runQuery();
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally { setSyncing(false); }
  };

  const toggleOne = (name: string) => setSelStaff((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  const toggleGroup = (names: string[]) => setSelStaff((prev) => {
    const allIn = names.length > 0 && names.every((n) => prev.includes(n));
    if (allIn) return prev.filter((n) => !names.includes(n));
    return Array.from(new Set([...prev, ...names]));
  });
  const toggleCountry = (c: string) => setSelCountry((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const staffOrder = React.useMemo(() => [...(meta?.staff.bd ?? []), ...(meta?.staff.editor ?? [])], [meta]);
  const staffColor = React.useCallback((name: string) => {
    const idx = staffOrder.indexOf(name);
    return paletteColor(idx >= 0 ? idx : hashIndex(name));
  }, [staffOrder]);
  const countryOrder = React.useMemo(() => meta?.countries ?? [], [meta]);
  const countryColor = React.useCallback((c: string) => {
    const idx = countryOrder.indexOf(c);
    return paletteColor(idx >= 0 ? idx : hashIndex(c));
  }, [countryOrder]);

  const onSort = (k: string) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  };

  const sortedRows = React.useMemo(() => {
    const rows = data?.grouped_rows ?? [];
    const arr = [...rows];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[sortKey as keyof GroupedRow], bv = b[sortKey as keyof GroupedRow];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), "zh") * dir;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const totals = React.useMemo(() => {
    const rows = data?.grouped_rows ?? [];
    const samples = rows.reduce((a, r) => a + (r.samples ?? 0), 0);
    const recovered = rows.reduce((a, r) => a + r.recovered, 0);
    return { samples, recovered };
  }, [data]);

  // ---- 国家占比 ----
  const countryPieItems = metric === "发样达人" ? data?.country_pie.sample ?? [] : data?.country_pie.recover ?? [];
  const countryPieTotal = metric === "发样达人" ? data?.country_pie.sample_total ?? 0 : data?.country_pie.recover_total ?? 0;
  const countrySlices = donutSlices(
    countryPieItems.map((it) => ({ value: it.count, color: pieCountryDrill && pieCountryDrill !== it.country ? "rgba(0,0,0,.10)" : countryColor(it.country) })),
    countryPieTotal,
  );

  // ---- 粉丝分层 ----
  const tierSource = pieCountryDrill
    ? (metric === "发样达人" ? data?.fan_tier_pie.sample_by_country[pieCountryDrill] : data?.fan_tier_pie.recover_by_country[pieCountryDrill]) ?? TIERS.map((t) => ({ tier: t, count: 0 }))
    : (metric === "发样达人" ? data?.fan_tier_pie.sample ?? [] : data?.fan_tier_pie.recover ?? []);
  const tierTotal = tierSource.reduce((a, b) => a + b.count, 0);
  const tierSlices = donutSlices(tierSource.map((it) => ({ value: it.count, color: TIER_COLOR[it.tier] })), tierTotal);

  // ---- 每日发样/回收 ----
  const days = React.useMemo(() => data?.daily_series ?? [], [data]);
  const chart = React.useMemo(() => {
    if (!days.length) return null;
    const maxCnt = Math.max(1, ...days.map((d) => Math.max(d.sample, d.recover)));
    const rateVals = days.map((d) => d.rate);
    const maxRate = Math.max(0.2, Math.ceil(Math.max(0, ...rateVals.map((v) => v ?? 0)) * 5) / 5);
    const axisCnt = Math.ceil(maxCnt / 0.7 / 4) * 4;
    const W = 1120, padL = 58, padR = 58, y0 = 356, yTop = 40;
    const plotW = W - padL - padR, plotH = y0 - yTop;
    const gw = plotW / days.length, bw = gw / 3, rateBase = y0 - 0.75 * plotH;
    const every = Math.max(1, Math.ceil(days.length / 15));
    const bars: { x: number; y: number; w: number; h: number; fill: string; opacity: number }[] = [];
    const lineNodes: { x: number; y: number }[] = [];
    const personNodes: { x: number; y: number }[] = [];
    const xTicks: { x: number; label: string }[] = [];
    days.forEach((d, i) => {
      const gx = padL + i * gw;
      const hS = (d.sample / axisCnt) * plotH, hM = (d.recover / axisCnt) * plotH;
      const hi = highlightStaff;
      bars.push({ x: gx, y: y0 - hS, w: bw, h: hS, fill: C_SEND, opacity: hi ? 0.35 : 1 });
      bars.push({ x: gx + bw, y: y0 - hM, w: bw, h: hM, fill: C_REC, opacity: hi ? 0.25 : 1 });
      if (hi && d.by_staff[hi]) {
        const pS = d.by_staff[hi].sample, pM = d.by_staff[hi].recover;
        const a = (pS / axisCnt) * plotH, b = (pM / axisCnt) * plotH;
        if (a) bars.push({ x: gx, y: y0 - a, w: bw, h: a, fill: C_SEND, opacity: 1 });
        if (b) bars.push({ x: gx + bw, y: y0 - b, w: bw, h: b, fill: C_REC, opacity: 1 });
      }
      if (d.rate != null) lineNodes.push({ x: gx + bw, y: rateBase - Math.min(d.rate / maxRate, 1) * (rateBase - yTop) });
      if (hi && d.by_staff[hi]?.sample) {
        const pr = d.by_staff[hi].recover / d.by_staff[hi].sample;
        personNodes.push({ x: gx + bw, y: rateBase - Math.min(pr / maxRate, 1) * (rateBase - yTop) });
      }
      if (i % every === 0) xTicks.push({ x: gx + bw, label: d.date.slice(5) });
    });
    const gridLines = [1, 2, 3, 4].map((t) => ({ y: y0 - (plotH * t) / 4 }));
    const yLeft = [0, 1, 2, 3, 4].map((t) => ({ y: y0 - (plotH * t) / 4, label: Math.round((axisCnt * t) / 4) }));
    const yRight = [0, 1, 2].map((t) => ({ y: rateBase - ((rateBase - yTop) * t) / 2, label: Math.round(((maxRate * t) / 2) * 100) + "%" }));
    return { W, H: 400, padL, padR, y0, yTop, plotW, plotH, gw, bw, rateBase, bars, lineNodes, personNodes, xTicks, gridLines, yLeft, yRight };
  }, [days, highlightStaff]);

  const onChartMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * chart.W;
    const i = Math.max(0, Math.min(days.length - 1, Math.round((fx - chart.padL - chart.bw) / chart.gw)));
    setHover({ i, px: e.clientX - rect.left, py: e.clientY - rect.top, flip: (e.clientX - rect.left) > rect.width * 0.72 });
  };

  const hv = hover ? days[hover.i] : null;
  const s = data?.summary;
  const cols = detail ? COL_DETAIL : COL_SUMMARY;
  const isQuick = (d: number) => from === agoIso(d - 1) && to === todayIso();

  return (
    <div className="h-full min-h-0 flex flex-col gap-2.5">
      {/* Header */}
      <div className="flex-none flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">发样及素材统计</h2>
          <p className="text-xs text-muted-foreground">BD 建联表发样/回收 + 剪辑登记表产出 · 按人员 / 国家 / SKU</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={syncing} onClick={doSync}>
            <RotateCw className={`h-4 w-4 mr-1.5 ${syncing ? "animate-spin" : ""}`} />同步飞书数据
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums inline-flex items-center gap-1.5">
            {loading && <RotateCw className="h-3 w-3 animate-spin" />}
            最近同步：{data?.last_synced_at ? new Date(data.last_synced_at).toLocaleString() : "—"}
          </span>
        </div>
      </div>

      {/* KPI cards — single row, label left / value right */}
      <div className="flex-none grid grid-cols-3 xl:grid-cols-6 gap-2">
        {[
          { label: "BD发样总数", value: s ? fmtNum(s.bd_sample_total) : "—" },
          { label: "BD回收素材", value: s ? fmtNum(s.bd_recover_total) : "—" },
          { label: "整体回收率", value: s ? fmtPct(s.bd_recover_rate) : "—", accent: true },
          { label: "BD日均回收素材", value: s && s.bd_daily_avg_recover != null ? s.bd_daily_avg_recover.toFixed(1) : "—" },
          { label: "剪辑总素材产出", value: s ? fmtNum(s.editor_output_total) : "—" },
          { label: "剪辑日均素材产出", value: s && s.editor_daily_avg_output != null ? s.editor_daily_avg_output.toFixed(1) : "—" },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="px-3 py-2 flex items-center justify-between gap-2">
              <div className="text-[10.5px] text-muted-foreground whitespace-nowrap">{k.label}</div>
              <div className={`font-mono text-base font-semibold whitespace-nowrap ${k.accent ? "text-primary" : ""}`}>{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters — 同事 as its own left half (2 rows: BD / 剪辑), 国家+日期 as a right half
          that always starts at the horizontal middle of the card (grid-cols-2, not flex-1),
          so its position doesn't drift with how many names happen to be in the left half. */}
      <Card className="flex-none">
        <CardContent className="p-2.5 grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-bold text-foreground flex-none w-9">同事</span>
              <Pill strong on={meta ? meta.staff.bd.length > 0 && meta.staff.bd.every((n) => selStaff.includes(n)) : false} onClick={() => toggleGroup(meta?.staff.bd ?? [])}>BD</Pill>
              {(meta?.staff.bd ?? []).map((n) => (
                <Pill key={n} on={selStaff.includes(n)} color={staffColor(n)} onClick={() => toggleOne(n)}>{n}</Pill>
              ))}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-foreground flex-none w-9" />
              <Pill strong on={meta ? meta.staff.editor.length > 0 && meta.staff.editor.every((n) => selStaff.includes(n)) : false} onClick={() => toggleGroup(meta?.staff.editor ?? [])}>剪辑</Pill>
              {(meta?.staff.editor ?? []).map((n) => (
                <Pill key={n} on={selStaff.includes(n)} color={staffColor(n)} onClick={() => toggleOne(n)}>{n}</Pill>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-bold text-foreground flex-none w-9">国家</span>
              <Pill strong on={selCountry.length === 0} onClick={() => setSelCountry([])}>全部</Pill>
              {countryOrder.map((c) => (
                <Pill key={c} on={selCountry.includes(c)} color={countryColor(c)} onClick={() => toggleCountry(c)}>{c}</Pill>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-foreground flex-none w-9">日期</span>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" />
              <span className="text-xs text-muted-foreground">至</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" />
              <div className="flex gap-0.5 p-0.5 bg-muted rounded-md">
                {QUICK_DAYS.map((d) => (
                  <button
                    key={d}
                    onClick={() => { setTo(todayIso()); setFrom(agoIso(d - 1)); }}
                    className={`text-[11px] px-2.5 py-1 rounded ${isQuick(d) ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}
                  >近{d}天</button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main grid — fixed rows so panels never resize with data, and 回收明细's bottom
          always lines up with the daily-chart card's bottom (both track the same grid rows). */}
      <div className={`flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] xl:grid-rows-[minmax(0,0.78fr)_minmax(0,1fr)] gap-2.5 transition-opacity ${loading ? "opacity-60" : ""}`}>
        {/* 回收明细表 */}
        <Card className="xl:row-span-2 flex flex-col min-h-0 overflow-hidden">
          <CardHeader className="pb-2 flex-none">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-baseline gap-2">
                <CardTitle className="text-base">回收明细</CardTitle>
                <span className="text-xs text-muted-foreground">{sortedRows.length} 行 · {detail ? "人员 / 国家 / SKU" : "按人员汇总"}</span>
              </div>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer flex-none">
                <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} className="h-3.5 w-3.5" />
                展示明细（国家 / SKU）
              </label>
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
            <div className="flex-none flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-y text-xs">
              {cols.map((c) => (
                <div key={c.key} style={{ flex: `${c.flex} 1 0`, textAlign: c.align }}>
                  <SortTH k={c.key} label={c.label} align={c.align} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                </div>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {sortedRows.map((r, i) => (
                <div
                  key={`${r.role}|${r.staff_name}|${r.country}|${r.sku}|${i}`}
                  className="flex items-center gap-2 px-3 h-8 border-b text-sm"
                  style={{ background: i % 2 ? "rgba(0,0,0,.015)" : "transparent", opacity: highlightStaff && highlightStaff !== r.staff_name ? 0.4 : 1 }}
                >
                  <div style={{ flex: `${cols[0].flex} 1 0` }} className="min-w-0 overflow-hidden">
                    <span className="inline-flex items-center gap-1.5 max-w-full">
                      <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: staffColor(r.staff_name) }} />
                      <span className="truncate">{r.staff_name}</span>
                      <span className="text-[10px] text-muted-foreground flex-none">{r.role === "BD" ? "BD" : "剪辑"}</span>
                    </span>
                  </div>
                  {detail && <div style={{ flex: "0.8 1 0" }} className="text-muted-foreground truncate">{r.country}</div>}
                  {detail && <div style={{ flex: "1.4 1 0" }} className="font-mono text-xs text-muted-foreground/90 truncate">{r.sku}</div>}
                  <div style={{ flex: "0.9 1 0", textAlign: "right" }} className="font-mono">{r.samples == null ? "—" : fmtNum(r.samples)}</div>
                  <div style={{ flex: "0.9 1 0", textAlign: "right" }} className="font-mono">{fmtNum(r.recovered)}</div>
                  <div style={{ flex: detail ? "1.6 1 0" : "1.8 1 0", textAlign: "right" }}>
                    <span className={`font-mono text-xs whitespace-nowrap ${r.rate != null && r.rate >= 0.5 ? "text-primary font-semibold" : ""}`}>
                      {fmtPct(r.rate)}
                    </span>
                  </div>
                </div>
              ))}
              {!sortedRows.length && (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">{loading ? "加载中…" : "暂无数据"}</div>
              )}
            </div>
            <div className="flex-none flex items-center gap-2 px-3 py-2 bg-muted/50 border-t text-sm font-semibold">
              <div style={{ flex: `${cols[0].flex} 1 0` }}>合计</div>
              {detail && <div style={{ flex: "0.8 1 0" }} />}
              {detail && <div style={{ flex: "1.4 1 0" }} />}
              <div style={{ flex: "0.9 1 0", textAlign: "right" }} className="font-mono">{fmtNum(totals.samples)}</div>
              <div style={{ flex: "0.9 1 0", textAlign: "right" }} className="font-mono">{fmtNum(totals.recovered)}</div>
              <div style={{ flex: detail ? "1.6 1 0" : "1.8 1 0", textAlign: "right" }} className="font-mono">{s ? fmtPct(s.bd_recover_rate) : "—"}</div>
            </div>
          </CardContent>
        </Card>

        {/* 国家占比 */}
        <Card className="flex flex-col min-h-0 overflow-hidden">
          <CardHeader className="pb-1.5 flex-none">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">国家占比（BD）</CardTitle>
              <div className="flex gap-0.5 p-0.5 bg-muted rounded-md flex-none">
                {(["发样达人", "回收素材"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMetric(m)}
                    className={`text-[10.5px] px-2 py-1 rounded whitespace-nowrap ${metric === m ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}
                  >{m}</button>
                ))}
              </div>
            </div>
            <div className="text-[10.5px] text-muted-foreground">点击切片/图例下钻，联动右侧粉丝分层统计范围</div>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 flex items-center gap-2 overflow-hidden pt-0">
            <div className="relative flex-none h-full aspect-square" style={{ maxWidth: "48%" }}>
              <svg viewBox="0 0 150 150" className="w-full h-full block">
                {countrySlices.map((sl, i) => (
                  <circle key={i} cx={75} cy={75} r={sl.r} fill="none" stroke={sl.color} strokeWidth={sl.sw}
                    strokeDasharray={sl.dash} strokeDashoffset={sl.offset} transform="rotate(-90 75 75)"
                    style={{ cursor: "pointer" }}
                    onClick={() => setPieCountryDrill((p) => (p === countryPieItems[i]?.country ? null : countryPieItems[i]?.country ?? null))} />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="font-mono text-lg font-semibold">{fmtNum(countryPieTotal)}</div>
              </div>
            </div>
            <div
              className="grid gap-x-2 gap-y-0.5 min-w-0 flex-1 content-center"
              style={{ gridTemplateColumns: countryPieItems.length > 6 ? "1fr 1fr" : "1fr" }}
            >
              {countryPieItems.map((it) => (
                <div key={it.country}
                  className="grid items-center gap-x-1 text-[10.5px] px-1 py-0.5 rounded cursor-pointer min-w-0 w-fit"
                  style={{
                    gridTemplateColumns: "8px auto auto",
                    background: pieCountryDrill === it.country ? "rgba(0,0,0,.06)" : "transparent",
                    fontWeight: pieCountryDrill === it.country ? 600 : 400,
                  }}
                  onClick={() => setPieCountryDrill((p) => (p === it.country ? null : it.country))}
                >
                  <span className="w-2 h-2 rounded-sm" style={{ background: countryColor(it.country) }} />
                  <span className="truncate max-w-[60px]">{it.country}</span>
                  <span className="text-right font-mono">{fmtPct(countryPieTotal ? it.count / countryPieTotal : null)}</span>
                </div>
              ))}
              {!countryPieItems.length && <div className="text-xs text-muted-foreground">{loading ? "加载中…" : "暂无数据"}</div>}
            </div>
          </CardContent>
        </Card>

        {/* 粉丝分层 */}
        <Card className="flex flex-col min-h-0 overflow-hidden">
          <CardHeader className="pb-1.5 flex-none">
            <CardTitle className="text-sm">粉丝量分布（BD{pieCountryDrill ? ` · ${pieCountryDrill}` : " · 全部国家"}）</CardTitle>
            <div className="text-[10.5px] text-muted-foreground">各达人按自己所在国家的门槛定档后合并统计</div>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 flex items-center gap-2 overflow-hidden pt-0">
            <div className="relative flex-none h-full aspect-square" style={{ maxWidth: "48%" }}>
              <svg viewBox="0 0 150 150" className="w-full h-full block">
                {tierSlices.map((sl, i) => (
                  <circle key={i} cx={75} cy={75} r={sl.r} fill="none" stroke={sl.color} strokeWidth={sl.sw}
                    strokeDasharray={sl.dash} strokeDashoffset={sl.offset} transform="rotate(-90 75 75)" />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="font-mono text-lg font-semibold">{fmtNum(tierTotal)}</div>
              </div>
            </div>
            <div className="grid gap-x-1.5 gap-y-1 min-w-0 text-[10.5px] w-fit" style={{ gridTemplateColumns: "8px auto auto auto auto" }}>
              {tierSource.map((it) => {
                const th = data?.fan_tier_pie.thresholds[it.tier];
                return (
                  <React.Fragment key={it.tier}>
                    <span className="w-2 h-2 rounded-sm self-center" style={{ background: TIER_COLOR[it.tier] }} />
                    <span className="font-semibold whitespace-nowrap">{it.tier}</span>
                    <span className="font-mono text-[9.5px] text-muted-foreground truncate">{th ? `其他${th.其他}·MX${th.MX}` : ""}</span>
                    <span className="text-right font-mono">{fmtPct(tierTotal ? it.count / tierTotal : null)}</span>
                    <span className="text-right font-mono text-muted-foreground whitespace-nowrap">{it.count}人</span>
                  </React.Fragment>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* 每日发样/回收 */}
        <Card className="xl:col-span-2 flex flex-col min-h-0 overflow-hidden">
          <CardHeader className="pb-1.5 flex-none">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <CardTitle className="text-sm">发样数量 / 回收素材数量（BD）</CardTitle>
              <div className="flex items-center gap-3 text-[10.5px] text-muted-foreground flex-wrap">
                <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: C_SEND }} />发样</span>
                <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: C_REC }} />回收素材</span>
                <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ background: C_LINE }} />回收率（右轴）</span>
                <span>选中同事后深色为其占比，浅橙虚线为其回收率</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 flex flex-col pt-0">
            <div className="relative flex-1 min-h-0">
              {chart ? (
                <>
                  <svg viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none" width="100%" height="100%" style={{ display: "block" }}>
                    {chart.gridLines.map((g, i) => (
                      <line key={i} x1={chart.padL} y1={g.y} x2={chart.W - chart.padR} y2={g.y} stroke="rgba(0,0,0,.08)" strokeWidth={1} />
                    ))}
                    {chart.bars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} opacity={b.opacity} />)}
                    <line x1={chart.padL} y1={chart.rateBase} x2={chart.W - chart.padR} y2={chart.rateBase} stroke={C_LINE} strokeWidth={1} strokeDasharray="3 4" opacity={0.45} />
                    <polyline points={chart.lineNodes.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join(" ")} fill="none" stroke={C_LINE} strokeWidth={2} strokeLinejoin="round" />
                    {highlightStaff && (
                      <polyline points={chart.personNodes.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join(" ")} fill="none" stroke={PERSON_LINE} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />
                    )}
                    {chart.lineNodes.map((n, i) => <circle key={i} cx={n.x} cy={n.y} r={3} fill="#fff" stroke={C_LINE} strokeWidth={2} />)}
                    {chart.xTicks.map((t, i) => <line key={i} x1={t.x} y1={356} x2={t.x} y2={361} stroke="rgba(0,0,0,.25)" strokeWidth={1} />)}
                    <line x1={chart.padL} y1={chart.y0} x2={chart.W - chart.padR} y2={chart.y0} stroke="rgba(0,0,0,.2)" strokeWidth={1} />
                    <line x1={chart.padL} y1={chart.yTop} x2={chart.padL} y2={chart.y0} stroke="rgba(0,0,0,.2)" strokeWidth={1} />
                    <line x1={chart.W - chart.padR} y1={chart.yTop} x2={chart.W - chart.padR} y2={chart.y0} stroke="rgba(0,0,0,.2)" strokeWidth={1} />
                  </svg>
                  <div className="absolute inset-0 pointer-events-none">
                    {chart.yLeft.map((t, i) => (
                      <div key={`l${i}`} className="absolute text-[10.5px] font-mono text-muted-foreground" style={{ top: `${(t.y / chart.H) * 100}%`, right: `${100 - (50 / chart.W) * 100}%`, transform: "translateY(-50%)" }}>{t.label}</div>
                    ))}
                    {chart.yRight.map((t, i) => (
                      <div key={`r${i}`} className="absolute text-[10.5px] font-mono" style={{ color: C_LINE, top: `${(t.y / chart.H) * 100}%`, left: `${(1070 / chart.W) * 100}%`, transform: "translateY(-50%)" }}>{t.label}</div>
                    ))}
                    {chart.xTicks.map((t, i) => (
                      <div key={`x${i}`} className="absolute text-[10.5px] font-mono text-muted-foreground/70" style={{ top: `${(372 / chart.H) * 100}%`, left: `${(t.x / chart.W) * 100}%`, transform: "translate(-50%,-50%)" }}>{t.label}</div>
                    ))}
                  </div>
                  <div onMouseMove={onChartMove} onMouseLeave={() => setHover(null)} className="absolute inset-0" style={{ cursor: "crosshair" }} />
                  {hv && hover && (
                    <div
                      className="absolute rounded-md px-2.5 py-2 text-xs pointer-events-none z-10"
                      style={{
                        left: hover.px, top: hover.py,
                        transform: hover.flip ? "translate(-108%,-50%)" : "translate(12px,-50%)",
                        background: "rgba(27,26,24,.93)", color: "#fff", boxShadow: "0 4px 14px rgba(0,0,0,.22)", lineHeight: 1.55,
                      }}
                    >
                      <div className="font-semibold mb-0.5">{hv.date}</div>
                      <div className="flex justify-between gap-4"><span className="opacity-70">发样 / 回收</span><span className="font-mono">{hv.sample} / {hv.recover}</span></div>
                      <div className="flex justify-between gap-4"><span className="opacity-70">回收率</span><span className="font-mono">{fmtPct(hv.rate)}</span></div>
                      {highlightStaff && (
                        <>
                          <div className="mt-1 pt-1 border-t border-white/20 flex justify-between gap-4"><span className="opacity-70">{highlightStaff} 发样/回收</span><span className="font-mono">{hv.by_staff[highlightStaff]?.sample ?? 0} / {hv.by_staff[highlightStaff]?.recover ?? 0}</span></div>
                          <div className="flex justify-between gap-4"><span className="opacity-70">{highlightStaff} 回收率</span><span className="font-mono">{hv.by_staff[highlightStaff]?.sample ? fmtPct(hv.by_staff[highlightStaff].recover / hv.by_staff[highlightStaff].sample) : "—"}</span></div>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">{loading ? "加载中…" : "暂无数据"}</div>
              )}
            </div>
            <div className="flex-none flex flex-wrap items-center justify-center gap-1.5 pt-1.5">
              <span className="text-[10.5px] text-muted-foreground mr-1">点击高亮同事</span>
              {(meta?.staff.bd ?? []).map((n) => (
                <button
                  key={n}
                  onClick={() => setHighlightStaff((p) => (p === n ? null : n))}
                  className="text-[10.5px] px-2.5 py-1 rounded-full border inline-flex items-center gap-1.5"
                  style={{ border: `1px solid ${highlightStaff === n ? "transparent" : "rgba(0,0,0,.13)"}`, background: highlightStaff === n ? staffColor(n) : "transparent", color: highlightStaff === n ? "#fff" : "rgba(0,0,0,.65)" }}
                >
                  <span className="w-2 h-2 rounded-full flex-none" style={{ background: highlightStaff === n ? "#fff" : staffColor(n) }} />
                  {n}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
