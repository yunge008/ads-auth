// Aggregated GMV Max daily report grouped by country / advertiser / date with delivery status counts.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

const STATUS_KEYS = [
  "IN_QUEUE",
  "LEARNING",
  "DELIVERING",
  "NOT_DELIVERYING",
  "NOT_ACTIVE",
  "AUTHORIZATION_NEEDED",
  "Unavailable",
  "Excluded",
  "Rejected",
] as const;
type StatusKey = typeof STATUS_KEYS[number];

type RawRow = {
  country: string | null;
  advertiser_id: string;
  vid: string;
  stat_date: string;
  creative_delivery_status: string | null;
  cost: number | null;
  gross_revenue: number | null;
  orders: number | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "feishu-data");
    const body = (await req.json().catch(() => ({}))) as {
      start_date?: string;
      end_date?: string;
      country?: string;
      vid?: string;
      page?: number;
      page_size?: number;
    };
    const page = Math.max(1, Math.floor(Number(body.page ?? 1)) || 1);
    const pageSize = Math.min(500, Math.max(20, Math.floor(Number(body.page_size ?? 100)) || 100));

    const db = admin();
    // Require an explicit date window — never silently match the whole table
    // when start_date / end_date is missing.
    const today = new Date().toISOString().slice(0, 10);
    const addDays = (d: string, n: number) => {
      const t = new Date(d + "T00:00:00Z");
      t.setUTCDate(t.getUTCDate() + n);
      return t.toISOString().slice(0, 10);
    };
    const startDate = (body.start_date && body.start_date.trim()) || addDays(today, -7);
    const endDate = (body.end_date && body.end_date.trim()) || today;
    const buildQuery = () => {
      let q = db
        .from("gmv_max_vid_daily")
        .select("country,advertiser_id,vid,stat_date,creative_delivery_status,cost,gross_revenue,orders")
        .order("stat_date", { ascending: false })
        .gte("stat_date", startDate)
        .lte("stat_date", endDate);
      if (body.country && body.country.trim()) q = q.eq("country", body.country.trim());
      if (body.vid && body.vid.trim()) q = q.eq("vid", body.vid.trim());
      return q;
    };

    // Page through all matching rows (avoid 1000-row default cap and 50k truncation).
    const PAGE = 1000;
    const rows: RawRow[] = [];
    for (let offset = 0; offset < 500000; offset += PAGE) {
      const { data, error } = await buildQuery().range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      const chunk = (data ?? []) as RawRow[];
      rows.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    // Aggregate by country+advertiser+date with DISTINCT VID counts.
    // row_count = distinct VID for that day/advertiser/country
    // status_counts[X] = distinct VID whose creative_delivery_status = X
    const groups = new Map<string, {
      country: string | null;
      advertiser_id: string;
      stat_date: string;
      vids: Set<string>;
      vidsByStatus: Map<StatusKey, Set<string>>;
    }>();
    for (const r of rows) {
      const key = `${r.country ?? ""}|${r.advertiser_id}|${r.stat_date}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          country: r.country,
          advertiser_id: r.advertiser_id,
          stat_date: r.stat_date,
          vids: new Set<string>(),
          vidsByStatus: new Map(STATUS_KEYS.map((k) => [k, new Set<string>()])),
        };
        groups.set(key, g);
      }
      const vid = (r.vid ?? "").trim();
      if (!vid) continue;
      g.vids.add(vid);
      const s = (r.creative_delivery_status ?? "").trim();
      if (s && (STATUS_KEYS as readonly string[]).includes(s)) {
        g.vidsByStatus.get(s as StatusKey)!.add(vid);
      }
    }

    // Fetch advertiser names
    const advIds = Array.from(new Set(rows.map((r) => r.advertiser_id)));
    const nameMap = new Map<string, string>();
    if (advIds.length) {
      const { data: adv } = await db
        .from("advertiser_countries")
        .select("advertiser_id,advertiser_name")
        .in("advertiser_id", advIds);
      for (const a of (adv ?? []) as Array<{ advertiser_id: string; advertiser_name: string | null }>) {
        if (a.advertiser_name) nameMap.set(a.advertiser_id, a.advertiser_name);
      }
    }

    const all = Array.from(groups.values())
      .map((g) => ({
        country: g.country,
        advertiser_id: g.advertiser_id,
        advertiser_name: nameMap.get(g.advertiser_id) ?? null,
        stat_date: g.stat_date,
        row_count: g.vids.size,
        status_counts: Object.fromEntries(
          STATUS_KEYS.map((k) => [k, g.vidsByStatus.get(k)!.size]),
        ) as Record<StatusKey, number>,
      }))
      .sort((a, b) => b.stat_date.localeCompare(a.stat_date)
        || String(a.country ?? "").localeCompare(String(b.country ?? ""))
        || a.advertiser_id.localeCompare(b.advertiser_id));

    const count = all.length;
    const from = (page - 1) * pageSize;
    const paged = all.slice(from, from + pageSize);

    return new Response(JSON.stringify({ rows: paged, count, page, page_size: pageSize, status_keys: STATUS_KEYS }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
