import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getAdminName, getPasscode } from "@/lib/api";

export const Route = createFileRoute("/creator-orders")({
  head: () => ({ meta: [{ title: "达人出单日报 - TikTok授权工具" }] }),
  component: CreatorOrdersPage,
});

// 达人出单日报（docs/CREATOR_ORDERS_PLAN.md）。数据：GMV Max 素材 × 商品 × 天（广告户时区），每小时刷新。
type Row = {
  site: string;
  vid: string;
  spu: string;
  handle: string | null;
  nick: string | null;
  acct: "ext" | "mk" | "own" | "card";
  owner: string | null;
  sku: string;
  pname: string | null;
  c: number;
  g: number;
  o: number;
  imp: number;
  clk: number;
  d: Record<string, [number, number, number]>;
};
type State = {
  advertiser_id: string;
  country: string;
  advertiser_name: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_rows: number | null;
};
type Resp = {
  rows: Row[];
  settings: { t_vid: number; t_cr: number; own_kw: string };
  states: State[];
};

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/public/hooks/creator-orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-passcode": getPasscode(),
      "x-admin-name": encodeURIComponent(getAdminName()),
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

const sgDate = (off = 0) =>
  new Date(Date.now() + 8 * 3600_000 + off * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${a}T00:00:00Z`); t <= Date.parse(`${b}T00:00:00Z`); t += 86400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const SPANS: { k: string; label: string; range: () => [string, string] }[] = [
  { k: "1", label: `今天 ${sgDate(0).slice(5)}`, range: () => [sgDate(0), sgDate(0)] },
  { k: "1y", label: `昨天 ${sgDate(-1).slice(5)}`, range: () => [sgDate(-1), sgDate(-1)] },
  { k: "7", label: "近 7 天", range: () => [sgDate(-6), sgDate(0)] },
  { k: "30", label: "近 30 天", range: () => [sgDate(-29), sgDate(0)] },
];
const SITE_ORDER = ["PH", "PH2", "TH", "MY", "VN", "SG", "JP", "MX-AR", "MX-NE", "MX-SJ", "US"];

const f = (n: number | null | undefined, dp?: number) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : dp != null
      ? n.toFixed(dp)
      : Math.abs(n) >= 1000
        ? Math.round(n).toLocaleString("en-US")
        : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);

type Agg = {
  o: number;
  g: number;
  c: number;
  imp: number;
  clk: number;
  daily: { o: number; g: number; c: number; roi: number | null }[];
  roi: number | null;
  ctr: number | null;
  cvr: number | null;
  cpm: number | null;
  cpa: number | null;
  peak: number;
};
function agg(rows: Row[], days: string[]): Agg {
  const daily = days.map(() => ({ o: 0, g: 0, c: 0, roi: null as number | null }));
  let o = 0,
    g = 0,
    c = 0,
    imp = 0,
    clk = 0;
  for (const r of rows) {
    o += r.o;
    g += r.g;
    c += r.c;
    imp += r.imp;
    clk += r.clk;
    days.forEach((d, i) => {
      const v = r.d[d];
      if (v) {
        daily[i].o += v[0];
        daily[i].g += v[1];
        daily[i].c += v[2];
      }
    });
  }
  for (const d of daily) d.roi = d.c ? d.g / d.c : null;
  return {
    o,
    g,
    c,
    imp,
    clk,
    daily,
    roi: c ? g / c : null,
    ctr: imp ? clk / imp : null,
    cvr: clk ? o / clk : null,
    cpm: imp ? (c / imp) * 1000 : null,
    cpa: o ? c / o : null,
    peak: Math.max(0, ...daily.map((d) => d.o)),
  };
}
type Group = Agg & { k: string; rows: Row[] };
function by(rows: Row[], key: (r: Row) => string, days: string[]): Group[] {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return [...m.entries()].map(([k, rs]) => ({ k, rows: rs, ...agg(rs, days) }));
}
const creatorKey = (r: Row) =>
  `${r.site}|${r.acct === "card" ? "商品卡" : (r.handle ?? `vid:${r.vid}`)}`;

const ACCT: Record<Row["acct"], [string, string]> = {
  ext: ["达人", "bg-muted text-muted-foreground"],
  mk: ["营销号", "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"],
  own: ["官号", "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"],
  card: ["商品卡", "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"],
};
const Tag = ({ a }: { a: Row["acct"] }) => (
  <span className={`ml-1 rounded px-1 text-[11px] leading-[17px] ${ACCT[a][1]}`}>{ACCT[a][0]}</span>
);
const Help = ({ text }: { text: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={`说明：${text}`}
        className="ml-1 inline-grid h-[15px] w-[15px] place-items-center rounded-full border border-muted-foreground text-[10px] text-muted-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        ?
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-60 text-xs">{text}</TooltipContent>
  </Tooltip>
);

const MET: Record<"g" | "o" | "c" | "roi", { label: string; money: boolean }> = {
  g: { label: "GMV (USD)", money: true },
  o: { label: "订单", money: false },
  c: { label: "花费", money: true },
  roi: { label: "ROI", money: false },
};
type MetKey = keyof typeof MET;
const C1 = "#0f8a84",
  C2 = "#e8a317";

function niceMax(x: number) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x)),
    n = x / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function Chart({ tot, days, pick }: { tot: Agg; days: string[]; pick: MetKey[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(1000);
  const [hover, setHover] = React.useState<number | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 230,
    L = 56,
    R = 56,
    T = 14,
    B = 26;
  const ser = (k: MetKey) => tot.daily.map((d) => (k === "roi" ? (d.roi ?? 0) : d[k]));
  const [k1, k2] = pick;
  const same = !!k2 && MET[k1].money && MET[k2].money;
  const m1 = niceMax(Math.max(...ser(k1), ...(same ? ser(k2) : [])));
  const m2 = k2 ? (same ? m1 : niceMax(Math.max(...ser(k2)))) : m1;
  const x = (i: number) => L + (days.length <= 1 ? 0 : (i * (w - L - R)) / (days.length - 1));
  const y = (v: number, m: number) => T + (H - T - B) * (1 - v / m);
  const step = Math.ceil(days.length / 10);
  const lines: [MetKey | undefined, number, string][] = [
    [k1, m1, C1],
    [k2, m2, C2],
  ];
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = e.clientX - r.left;
    setHover(
      Math.max(
        0,
        Math.min(
          days.length - 1,
          Math.round((px - L) / ((w - L - R) / Math.max(1, days.length - 1))),
        ),
      ),
    );
  };
  const hd = hover != null ? tot.daily[hover] : null;
  return (
    <div ref={ref} className="relative rounded-lg border bg-card px-3 py-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: C1 }} />
          {MET[k1].label}
        </span>
        {k2 && (
          <span>
            <i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: C2 }} />
            {MET[k2].label}
            {same ? "（与左轴同刻度）" : ""}
          </span>
        )}
      </div>
      <svg
        width={w}
        height={H}
        viewBox={`0 0 ${w} ${H}`}
        role="img"
        aria-label="所选指标按日走势"
        className="block max-w-full"
      >
        {[0, 1, 2, 3, 4].map((t) => {
          const yy = T + ((H - T - B) * t) / 4;
          return (
            <g key={t} className="fill-muted-foreground text-[11px]">
              <line x1={L} x2={w - R} y1={yy} y2={yy} className="stroke-border" />
              <text x={L - 6} y={yy + 4} textAnchor="end">
                {f(m1 * (1 - t / 4))}
              </text>
              {k2 && (
                <text x={w - R + 6} y={yy + 4}>
                  {f(m2 * (1 - t / 4))}
                </text>
              )}
            </g>
          );
        })}
        {days.map((d, i) =>
          i % step === 0 || i === days.length - 1 ? (
            <text
              key={d}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {d.slice(5)}
            </text>
          ) : null,
        )}
        {lines.map(
          ([k, m, c]) =>
            k && (
              <polyline
                key={k}
                fill="none"
                stroke={c}
                strokeWidth={2}
                points={ser(k)
                  .map((v, i) => `${x(i).toFixed(1)},${y(v, m).toFixed(1)}`)
                  .join(" ")}
              />
            ),
        )}
        {hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={T}
              y2={H - B}
              className="stroke-muted-foreground"
              strokeDasharray="3 3"
            />
            {lines.map(
              ([k, m, c]) =>
                k && (
                  <circle
                    key={k}
                    cx={x(hover)}
                    cy={y(ser(k)[hover], m)}
                    r={4}
                    fill={c}
                    className="stroke-card"
                    strokeWidth={2}
                  />
                ),
            )}
          </>
        )}
        <rect
          x={L}
          y={T}
          width={Math.max(0, w - L - R)}
          height={H - T - B}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hd && hover != null && (
        <div
          className="pointer-events-none absolute top-8 z-10 min-w-36 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          style={x(hover) + 170 > w ? { left: x(hover) - 170 } : { left: x(hover) + 14 }}
        >
          <b className="mb-1 block">{days[hover]}</b>
          {(
            [
              ["g", "GMV", f(hd.g)],
              ["o", "订单", f(hd.o)],
              ["c", "消耗", f(hd.c)],
              ["roi", "ROI", f(hd.roi, 2)],
            ] as const
          ).map(([k, n, v]) => (
            <div
              key={k}
              className={`flex justify-between gap-4 tabular-nums ${pick.includes(k) ? "font-bold" : ""}`}
            >
              <span>{n}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spark({ daily, hot }: { daily: { o: number }[]; hot: boolean }) {
  const pts = daily.map((d) => d.o),
    m = Math.max(1, ...pts),
    w = 60,
    h = 16;
  const p = pts.map(
    (v, i) =>
      `${((i * (w - 4)) / Math.max(1, pts.length - 1) + 2).toFixed(1)},${(h - 2 - (v / m) * (h - 4)).toFixed(1)}`,
  );
  const [lx, ly] = (p[p.length - 1] ?? "0,0").split(",");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="ml-auto">
      <polyline
        points={p.join(" ")}
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={1.2}
      />
      <circle cx={lx} cy={ly} r={2.3} fill={hot ? "#d9480f" : C1} />
    </svg>
  );
}

const COLS: [string, string | null, boolean, string, string?][] = [
  ["达人", "handle", false, "15%"],
  ["站点", null, false, "4.5%"],
  ["素材 VID", null, false, "13%"],
  ["SKU/PID", null, false, "12%", "主 SKU：商品对应货号 AR / NE + 3–4 位数字；下行为 PID"],
  ["归属", null, false, "6.5%"],
  ["订单", "o", true, "5%"],
  ["GMV (USD)", "g", true, "7%"],
  ["花费", "c", true, "6%"],
  ["ROI", "roi", true, "4.5%", "GMV ÷ 花费"],
  ["CTR", "ctr", true, "4.5%", "商品点击 ÷ 商品曝光"],
  ["CVR", "cvr", true, "4.5%", "订单 ÷ 商品点击"],
  ["CPM", "cpm", true, "4.5%", "花费 ÷ 商品曝光 × 1000"],
  ["CPA", "cpa", true, "4.5%", "花费 ÷ 订单"],
  ["走势", null, true, "6%"],
];

function CreatorOrdersPage() {
  const [tab, setTab] = React.useState<"data" | "set" | "help">("data");
  const [dim, setDim] = React.useState<"creator" | "vid" | "sku">("creator");
  const [span, setSpan] = React.useState("7");
  const [sites, setSites] = React.useState<Set<string> | null>(null);
  const [acct, setAcct] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState<{ k: string; dir: number }>({ k: "o", dir: -1 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [pick, setPick] = React.useState<MetKey[]>(["o", "roi"]);
  const [data, setData] = React.useState<Resp | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [setForm, setSetForm] = React.useState({ t_vid: 10, t_cr: 20, own_kw: "artphro" });
  const [progress, setProgress] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(15);
  const tableRef = React.useRef<HTMLElement>(null);
  const theadRef = React.useRef<HTMLTableSectionElement>(null);
  const footRef = React.useRef<HTMLDivElement>(null);

  const [start, end] = (SPANS.find((s) => s.k === span) ?? SPANS[2]).range();
  const days = React.useMemo(() => daysBetween(start, end), [start, end]);
  const load = React.useCallback(() => {
    setLoading(true);
    api<Resp>({ action: "query", start, end })
      .then((r) => {
        setData(r);
        setSetForm(r.settings);
      })
      .catch((e) => toast.error(`读取失败：${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, [start, end]);
  React.useEffect(load, [load]);

  const allSites = React.useMemo(() => {
    const s = new Set<string>([
      ...(data?.rows ?? []).map((r) => r.site),
      ...(data?.states ?? []).map((x) => x.country),
    ]);
    return [...s].sort(
      (a, b) =>
        ((SITE_ORDER.indexOf(a) + 99) % 199) - ((SITE_ORDER.indexOf(b) + 99) % 199) ||
        a.localeCompare(b),
    );
  }, [data]);
  const on = React.useMemo(() => sites ?? new Set(allSites), [sites, allSites]);
  const st = data?.settings ?? { t_vid: 10, t_cr: 20, own_kw: "artphro" };
  const rows = React.useMemo(() => {
    const qq = q.trim().toLowerCase();
    return (data?.rows ?? []).filter(
      (r) =>
        on.has(r.site) &&
        (!acct || r.acct === acct) &&
        (!owner || (owner === "未归属" ? !r.owner : r.owner === owner)) &&
        (!qq ||
          [r.handle, r.nick, r.vid, r.sku, r.spu, r.pname].some((x) =>
            String(x ?? "")
              .toLowerCase()
              .includes(qq),
          )),
    );
  }, [data, on, acct, owner, q]);
  const owners = React.useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.owner).filter(Boolean) as string[])].sort(),
    [data],
  );
  const tot = React.useMemo(() => agg(rows, days), [rows, days]);
  const crG = React.useMemo(() => by(rows, creatorKey, days), [rows, days]);
  const vidG = React.useMemo(
    () => by(rows, (r) => `${r.site}|${r.vid}|${r.vid === "-1" ? r.spu : ""}`, days),
    [rows, days],
  );
  const hotC = new Set(
    crG.filter((g) => g.rows[0].acct !== "card" && g.peak >= st.t_cr).map((g) => g.k),
  );
  const hotV = new Set(
    vidG.filter((g) => g.rows[0].vid !== "-1" && g.peak >= st.t_vid).map((g) => g.k),
  );
  const multi = days.length > 1;

  const groups = React.useMemo(() => {
    const gs =
      dim === "creator" ? crG : dim === "vid" ? vidG : by(rows, (r) => `${r.site}|${r.spu}`, days);
    const k = sort.k;
    const val = (g: Group): string | number =>
      k === "handle"
        ? (g.rows[0].handle ?? "")
        : ((g as unknown as Record<string, number | null>)[k] ?? -1);
    return [...gs].sort((a, b) => {
      const va = val(a),
        vb = val(b);
      return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
    });
  }, [dim, crG, vidG, rows, days, sort]);

  React.useEffect(() => setPage(0), [dim, span, sites, acct, owner, q, sort]);
  // 每页行数：表头贴住屏幕顶部、拉到底刚好看到本页最后一行和页脚
  React.useLayoutEffect(() => {
    const calc = () => {
      const row = tableRef.current?.querySelector("tbody tr:not(.co-child)") as HTMLElement | null;
      const rowH = row?.offsetHeight || 46;
      const avail =
        window.innerHeight -
        (theadRef.current?.offsetHeight ?? 36) -
        (footRef.current?.offsetHeight ?? 36) -
        8;
      setPageSize(Math.max(5, Math.floor(avail / rowH)));
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, [data, dim, tab]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const goPage = (n: number) => {
    setPage(n);
    requestAnimationFrame(() =>
      tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const ownerCell = (rs: Row[]) => {
    const u = [...new Set(rs.map((r) => r.owner))],
      k = u.filter(Boolean) as string[];
    return k.length ? (
      <span title={k.join("、")}>
        {k[0]}
        {k.length > 1 && <span className="text-muted-foreground"> +{k.length - 1}</span>}
      </span>
    ) : (
      <span className="text-amber-600">未归属</span>
    );
  };
  const who = (r: Row) =>
    r.acct === "card" ? (
      <span className="text-muted-foreground">商品卡</span>
    ) : (
      <span className="inline-flex min-w-0 flex-col leading-tight select-text">
        <span className="truncate">
          {r.handle ?? <span className="text-amber-600">未识别</span>}
          <Tag a={r.acct} />
        </span>
        <small className="truncate text-[11.5px] text-muted-foreground">{r.nick ?? ""}</small>
      </span>
    );
  const vidCell = (r: Row) =>
    r.vid === "-1" ? (
      <span className="text-muted-foreground">商品卡</span>
    ) : (
      <span className="inline-flex min-w-0 flex-col leading-tight select-text">
        <span className="truncate font-mono text-[12.5px]">{r.vid}</span>
        <small className="truncate text-[11.5px] text-muted-foreground">{r.pname ?? ""}</small>
      </span>
    );
  const skuCell = (r: Row) => (
    <span className="inline-flex min-w-0 flex-col leading-tight select-text">
      <span className="truncate">{r.sku || <span className="text-muted-foreground">—</span>}</span>
      <small className="truncate font-mono text-[11.5px] text-muted-foreground">{r.spu}</small>
    </span>
  );
  const Tog = ({ k }: { k: string }) => (
    <button
      type="button"
      onClick={() => toggle(k)}
      aria-expanded={open.has(k)}
      aria-label={open.has(k) ? "收起" : "展开"}
      className="mr-1 inline-grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ChevronRight className={`h-5 w-5 transition-transform ${open.has(k) ? "rotate-90" : ""}`} />
    </button>
  );
  const metrics = (x: Agg, hot: boolean) => [
    <>
      {hot && <span className="text-orange-600">🔥 </span>}
      {f(x.o)}
    </>,
    f(x.g),
    x.c ? f(x.c) : "—",
    x.roi == null ? (
      "—"
    ) : (
      <span
        className={
          x.roi >= 3
            ? "font-medium text-green-700 dark:text-green-400"
            : x.roi < 1.5
              ? "text-red-600"
              : ""
        }
      >
        {x.roi.toFixed(2)}
      </span>
    ),
    pct(x.ctr),
    pct(x.cvr),
    f(x.cpm, 2),
    f(x.cpa, 2),
    <Spark daily={x.daily} hot={hot} />,
  ];
  const tr = (cells: React.ReactNode[], cls: string, key: string) => (
    <tr key={key} className={cls}>
      {cells.map((c, i) => (
        <td
          key={i}
          className={`overflow-hidden text-ellipsis whitespace-nowrap border-b px-2.5 py-1.5 align-middle ${COLS[i][2] ? "text-right tabular-nums" : ""}`}
        >
          {c}
        </td>
      ))}
    </tr>
  );

  const body: React.ReactNode[] = [];
  for (const g of groups.slice(cur * pageSize, (cur + 1) * pageSize)) {
    const r = g.rows[0];
    const isHot = dim === "creator" ? hotC.has(g.k) : dim === "vid" ? hotV.has(g.k) : false;
    const nV = new Set(g.rows.map((x) => x.vid)).size,
      nC = new Set(g.rows.map(creatorKey)).size;
    const hotCls = isHot ? "shadow-[inset_3px_0_0_#d9480f]" : "";
    if (dim === "creator") {
      body.push(
        tr(
          [
            <span className="flex items-center">
              <Tog k={g.k} />
              {who(r)}
            </span>,
            r.site,
            <span className="text-muted-foreground">{nV} 个</span>,
            r.sku || "—",
            ownerCell(g.rows),
            ...metrics(g, isHot),
          ],
          hotCls,
          g.k,
        ),
      );
      if (open.has(g.k))
        for (const x of by(g.rows, (y) => y.vid, days).sort((a, b) => b.o - a.o))
          body.push(
            tr(
              [
                "",
                "",
                vidCell(x.rows[0]),
                skuCell(x.rows[0]),
                ownerCell(x.rows),
                ...metrics(x, false),
              ],
              "co-child bg-muted/50 text-[13px] shadow-[inset_3px_0_0_hsl(var(--primary))]",
              `${g.k}/${x.k}`,
            ),
          );
    } else if (dim === "vid") {
      body.push(
        tr(
          [who(r), r.site, vidCell(r), skuCell(r), ownerCell(g.rows), ...metrics(g, isHot)],
          hotCls,
          g.k,
        ),
      );
    } else {
      body.push(
        tr(
          [
            <span className="flex items-center">
              <Tog k={g.k} />
              <span className="text-muted-foreground">{nC} 位</span>
            </span>,
            r.site,
            <span className="text-muted-foreground">{nV} 个</span>,
            skuCell(r),
            ownerCell(g.rows),
            ...metrics(g, false),
          ],
          "",
          g.k,
        ),
      );
      if (open.has(g.k))
        for (const x of by(g.rows, creatorKey, days).sort((a, b) => b.o - a.o))
          body.push(
            tr(
              [
                <span className="pl-8">{who(x.rows[0])}</span>,
                "",
                <span className="text-muted-foreground">
                  {new Set(x.rows.map((y) => y.vid)).size} 个
                </span>,
                "",
                ownerCell(x.rows),
                ...metrics(x, false),
              ],
              "co-child bg-muted/50 text-[13px]",
              `${g.k}/${x.k}`,
            ),
          );
    }
  }

  const kpi = (k: MetKey, val: string) => {
    const sel = multi && pick.includes(k),
      color = pick[0] === k ? C1 : C2;
    return (
      <button
        key={k}
        type="button"
        disabled={!multi}
        aria-pressed={sel}
        onClick={() =>
          setPick((p) =>
            p.includes(k) ? (p.length > 1 ? p.filter((x) => x !== k) : p) : [...p, k].slice(-2),
          )
        }
        className="relative grid min-w-0 gap-0.5 rounded-lg border bg-card px-3 py-2 text-left disabled:cursor-default"
        style={
          sel
            ? { borderColor: color, background: `color-mix(in srgb, ${color} 9%, transparent)` }
            : undefined
        }
      >
        <small className="text-xs text-muted-foreground">{MET[k].label}</small>
        <strong className="truncate text-xl font-bold tabular-nums">{val}</strong>
        {multi && (
          <span
            aria-hidden
            className="absolute right-2.5 top-2.5 h-3.5 w-3.5 rounded-[3px] border-[1.5px]"
            style={sel ? { background: color, borderColor: color } : undefined}
          />
        )}
      </button>
    );
  };
  const plain = (n: string, v: string, s2?: string) => (
    <div className="grid min-w-0 gap-0.5 rounded-lg border bg-card px-3 py-2">
      <small className="text-xs text-muted-foreground">{n}</small>
      <strong className="truncate text-xl font-bold tabular-nums">{v}</strong>
      {s2 && <span className="truncate text-xs text-muted-foreground">{s2}</span>}
    </div>
  );
  const chip = (on: boolean) =>
    `h-6 rounded-full border px-2.5 text-xs ${on ? "border-primary bg-primary/10 font-medium text-primary" : "bg-background hover:bg-muted"}`;
  const lastOk = (data?.states ?? [])
    .map((s) => s.last_ok_at)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mx-auto grid max-w-[1760px] gap-3 p-4">
        <div className="flex items-end gap-5 border-b">
          {(["data", "set", "help"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-0.5 pb-2 pt-1 text-sm ${tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}
            >
              {{ data: "数据", set: "设置", help: "说明" }[t]}
            </button>
          ))}
          <span className="ml-auto pb-2 text-xs text-muted-foreground">
            {lastOk
              ? `GMV Max 更新于 ${new Date(lastOk).toLocaleString("zh-CN", { hour12: false })}`
              : ""}
          </span>
        </div>

        {tab === "data" && (
          <>
            <div
              role="toolbar"
              aria-label="筛选"
              className="flex flex-wrap items-center gap-y-2 rounded-lg border bg-card px-2 py-1.5 [&>*]:border-l [&>*]:px-3 [&>*:first-child]:border-l-0 [&>*:first-child]:pl-0"
            >
              <div className="flex gap-0.5 rounded-md bg-muted p-0.5" aria-label="维度">
                {(["creator", "vid", "sku"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={dim === d}
                    onClick={() => {
                      setDim(d);
                      setOpen(new Set());
                    }}
                    className={`rounded px-3.5 py-0.5 text-sm ${dim === d ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  >
                    {{ creator: "达人", vid: "素材", sku: "SKU" }[d]}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1" aria-label="站点">
                <button
                  type="button"
                  className="px-1 text-xs text-primary"
                  onClick={() => setSites(new Set(allSites))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="px-1 text-xs text-primary"
                  onClick={() => setSites(new Set())}
                >
                  全不选
                </button>
                {allSites.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on.has(s)}
                    className={chip(on.has(s))}
                    onClick={() => {
                      const n = new Set(on);
                      if (n.has(s)) n.delete(s);
                      else n.add(s);
                      setSites(n);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  aria-label="日期"
                  className="h-7 rounded-md border bg-background px-2 text-sm"
                  value={span}
                  onChange={(e) => setSpan(e.target.value)}
                >
                  {SPANS.map((s) => (
                    <option key={s.k} value={s.k}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="账号类型"
                  className="h-7 rounded-md border bg-background px-2 text-sm"
                  value={acct}
                  onChange={(e) => setAcct(e.target.value)}
                >
                  <option value="">全部账号</option>
                  <option value="ext">达人</option>
                  <option value="mk">营销号</option>
                  <option value="own">官号</option>
                  <option value="card">商品卡</option>
                </select>
                <select
                  aria-label="归属同事"
                  className="h-7 rounded-md border bg-background px-2 text-sm"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="">全部同事</option>
                  {owners.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                  <option>未归属</option>
                </select>
                <button
                  type="button"
                  aria-label="重新读取"
                  title="重新读取"
                  onClick={load}
                  className="grid h-7 w-7 place-items-center rounded-md border hover:bg-muted"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
              </div>
              <div className="ml-auto">
                <input
                  aria-label="搜索"
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="达人 / 昵称 / VID / SKU / PID"
                  className="h-7 w-60 rounded-md border bg-background px-2 text-sm"
                />
              </div>
            </div>

            <section
              aria-label="汇总"
              className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
            >
              {kpi("g", f(tot.g))}
              {kpi("o", f(tot.o))}
              {kpi("c", f(tot.c))}
              {kpi("roi", f(tot.roi, 2))}
              {plain("CTR", pct(tot.ctr))}
              {plain("CVR", pct(tot.cvr))}
              {plain("CPA", f(tot.cpa, 2))}
              {plain(
                "爆单",
                String(hotC.size + hotV.size),
                `达人 ${hotC.size} · 素材 ${hotV.size}`,
              )}
            </section>

            {multi && <Chart tot={tot} days={days} pick={pick} />}

            <section ref={tableRef} className="min-w-0 scroll-mt-0 rounded-lg border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1560px] table-fixed border-collapse text-sm">
                  <colgroup>
                    {COLS.map((c) => (
                      <col key={c[0]} style={{ width: c[3] }} />
                    ))}
                  </colgroup>
                  <thead ref={theadRef}>
                    <tr>
                      {COLS.map(([n, k, num, , tip]) => (
                        <th
                          key={n}
                          className={`border-b px-2.5 py-2 text-xs font-medium text-muted-foreground ${num ? "text-right" : "text-left"} ${k ? "cursor-pointer hover:text-foreground" : ""}`}
                          onClick={
                            k
                              ? () => setSort((s) => ({ k, dir: s.k === k ? -s.dir : -1 }))
                              : undefined
                          }
                        >
                          {n}
                          {tip && <Help text={tip} />}
                          {sort.k === k ? (sort.dir < 0 ? " ↓" : " ↑") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.length ? (
                      body
                    ) : (
                      <tr>
                        <td colSpan={COLS.length} className="p-8 text-center text-muted-foreground">
                          {loading ? "读取中…" : on.size ? "所选日期没有数据" : "未选站点"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div
                ref={footRef}
                className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-muted-foreground"
              >
                <span>{groups.length} 行</span>
                <span className="ml-auto flex items-center gap-1" aria-label="分页">
                  <button
                    type="button"
                    disabled={cur === 0}
                    onClick={() => goPage(cur - 1)}
                    className="h-7 rounded-md border px-2 hover:bg-muted disabled:opacity-40"
                  >
                    ‹ 上一页
                  </button>
                  <span className="px-2 tabular-nums">
                    第 {cur + 1} / {pages} 页
                  </span>
                  <button
                    type="button"
                    disabled={cur >= pages - 1}
                    onClick={() => goPage(cur + 1)}
                    className="h-7 rounded-md border px-2 hover:bg-muted disabled:opacity-40"
                  >
                    下一页 ›
                  </button>
                </span>
              </div>
            </section>
          </>
        )}

        {tab === "set" && (
          <div className="grid max-w-4xl gap-4 rounded-lg border bg-card p-4 text-sm">
            <h3 className="font-medium">爆单标记（所选日期内任一天达到即标）</h3>
            <div className="grid grid-cols-[max-content_110px_auto] items-center gap-x-3 gap-y-2">
              <label htmlFor="co-tvid">单素材单日订单 ≥</label>
              <input
                id="co-tvid"
                type="number"
                min={1}
                className="h-8 rounded-md border bg-background px-2"
                value={setForm.t_vid}
                onChange={(e) => setSetForm({ ...setForm, t_vid: +e.target.value })}
              />
              <span className="text-muted-foreground">单</span>
              <label htmlFor="co-tcr">单达人单日订单 ≥</label>
              <input
                id="co-tcr"
                type="number"
                min={1}
                className="h-8 rounded-md border bg-background px-2"
                value={setForm.t_cr}
                onChange={(e) => setSetForm({ ...setForm, t_cr: +e.target.value })}
              />
              <span className="text-muted-foreground">单</span>
              <label htmlFor="co-kw">官号：账号名包含</label>
              <input
                id="co-kw"
                className="h-8 rounded-md border bg-background px-2"
                value={setForm.own_kw}
                onChange={(e) => setSetForm({ ...setForm, own_kw: e.target.value })}
              />
              <span className="text-muted-foreground">另加接口标为官号的账号</span>
            </div>
            <div>
              <button
                type="button"
                disabled={busy}
                className="h-8 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-60"
                onClick={() => {
                  setBusy(true);
                  api({ action: "settings", ...setForm })
                    .then(() => {
                      toast.success("已保存");
                      load();
                    })
                    .catch((e) => toast.error((e as Error).message))
                    .finally(() => setBusy(false));
                }}
              >
                保存
              </button>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <h3 className="font-medium">各广告户同步</h3>
              <button
                type="button"
                disabled={busy}
                className="ml-auto h-8 rounded-md border px-3 hover:bg-muted disabled:opacity-60"
                onClick={async () => {
                  setBusy(true);
                  try {
                    let cursor: number | null = 0,
                      errs = 0;
                    while (cursor != null) {
                      const r: {
                        next: number | null;
                        total: number;
                        report: { error?: string }[];
                      } = await api({ action: "refresh_step", cursor });
                      errs += r.report.filter((x) => x.error).length;
                      cursor = r.next;
                      setProgress(`同步 ${cursor ?? r.total} / ${r.total}（广告户 × 天）`);
                    }
                    cursor = 0;
                    while (cursor != null) {
                      const r: { next: number | null; total: number } = await api({
                        action: "names_step",
                        cursor,
                      });
                      cursor = r.next;
                      setProgress(`补达人名 ${cursor ?? r.total} / ${r.total} 个站点`);
                    }
                    if (errs) toast.warning(`已刷新，${errs} 个户有问题，见下表`);
                    else toast.success("已刷新今天和昨天");
                    load();
                  } catch (e) {
                    toast.error((e as Error).message);
                  } finally {
                    setBusy(false);
                    setProgress("");
                  }
                }}
              >
                {busy ? progress || "刷新中…" : "立即刷新"}
              </button>
            </div>
            <table className="w-full table-fixed border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  {["站点", "广告户", "最近成功", "行数", "问题"].map((h) => (
                    <th key={h} className="border bg-muted/50 px-2 py-1 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.states ?? [])
                  .sort((a, b) => a.country.localeCompare(b.country))
                  .map((s) => (
                    <tr key={s.advertiser_id}>
                      <td className="border px-2 py-1">{s.country}</td>
                      <td className="border px-2 py-1">{s.advertiser_name ?? s.advertiser_id}</td>
                      <td className="border px-2 py-1">
                        {s.last_ok_at
                          ? new Date(s.last_ok_at).toLocaleString("zh-CN", { hour12: false })
                          : "—"}
                      </td>
                      <td className="border px-2 py-1 text-right">{s.last_rows ?? "—"}</td>
                      <td className="border px-2 py-1 text-amber-700 dark:text-amber-400">
                        {s.last_error ?? ""}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "help" && (
          <div className="grid max-w-4xl gap-3 rounded-lg border bg-card p-4 text-[13px]">
            <h3 className="text-sm font-medium">数据来源</h3>
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[42%]" />
                <col className="w-[12%]" />
                <col />
              </colgroup>
              <thead>
                <tr className="text-left text-muted-foreground">
                  {["列", "来源", "更新", "备注"].map((h) => (
                    <th key={h} className="border bg-muted/50 px-2 py-1 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="[&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_td:first-child]:font-medium">
                <tr>
                  <td>订单、GMV、花费、ROI、CTR、CVR</td>
                  <td>GMV Max 报表（素材 × 商品 × 天）</td>
                  <td>每小时</td>
                  <td>订单与 GMV 含自然流量</td>
                </tr>
                <tr>
                  <td>CPM、CPA</td>
                  <td>花费 ÷ 商品曝光 × 1000；花费 ÷ 订单</td>
                  <td>同上</td>
                  <td>曝光为商品广告曝光</td>
                </tr>
                <tr>
                  <td>达人用户名、昵称、账号类型</td>
                  <td>TikTok Shop 视频分析（按 VID）</td>
                  <td>每小时补新 VID</td>
                  <td>昵称只有出单视频才有</td>
                </tr>
                <tr>
                  <td>SKU</td>
                  <td>飞书「SKU匹配表-TK」，取商品对应的基础货号</td>
                  <td>每晚</td>
                  <td>报表只到商品（PID）</td>
                </tr>
                <tr>
                  <td>归属</td>
                  <td>VID 登记人优先，其次达人归属（用户名、昵称）</td>
                  <td>每晚</td>
                  <td>官号显示「官号」</td>
                </tr>
              </tbody>
            </table>
            <h3 className="text-sm font-medium">口径</h3>
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[22%]" />
                <col />
              </colgroup>
              <tbody className="[&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td:first-child]:font-medium">
                <tr>
                  <td>日期</td>
                  <td>按各广告户时区的自然日（GMV Max 素材数据只能按天取）</td>
                </tr>
                <tr>
                  <td>ROI</td>
                  <td>GMV ÷ 花费</td>
                </tr>
                <tr>
                  <td>CTR / CVR</td>
                  <td>商品点击 ÷ 商品曝光；订单 ÷ 商品点击</td>
                </tr>
                <tr>
                  <td>金额</td>
                  <td>广告户币种（当前全部为 USD）</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
