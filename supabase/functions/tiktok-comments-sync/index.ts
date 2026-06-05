// Sync TikTok ad comments for all advertisers across tiktok_connections.
// Body: { advertiser_ids?: string[]; max_pages?: number; days?: number; start_date?: string; end_date?: string; incremental?: boolean }
// Auto-splits date range into <=30-day windows (TikTok API hard limit).
// If incremental=true (default), uses tiktok_comment_sync_state.last_synced_until as the window start when newer than start_date.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode, type ConnRow } from "../_shared/auth.ts";

const TT = "https://business-api.tiktok.com/open_api/v1.3";

type CommentRow = {
  advertiser_id: string;
  country: string | null;
  comment_id: string;
  parent_comment_id: string | null;
  vid: string | null;
  text: string | null;
  like_count: number;
  reply_count: number;
  username: string | null;
  avatar_url: string | null;
  comment_type: string | null;
  comment_create_time: string | null;
  pulled_at: string;
};

function fmtDate(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(s: string, n: number) {
  const t = new Date(s + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return fmtDate(t);
}
function daysBetween(a: string, b: string) {
  const t1 = new Date(a + "T00:00:00Z").getTime();
  const t2 = new Date(b + "T00:00:00Z").getTime();
  return Math.round((t2 - t1) / 86400000);
}
function splitWindows(start: string, end: string, max = 30): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cur = start;
  while (daysBetween(cur, end) >= 0) {
    const next = addDays(cur, max - 1);
    const stop = daysBetween(next, end) > 0 ? end : next;
    out.push([cur, stop]);
    cur = addDays(stop, 1);
  }
  return out;
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchAdgroupsRaw(token: string, advertiser_id: string, page = 1) {
  const url = new URL(`${TT}/adgroup/get/`);
  url.searchParams.set("advertiser_id", advertiser_id);
  url.searchParams.set("fields", JSON.stringify(["adgroup_id", "adgroup_name"]));
  url.searchParams.set("page_size", "1000");
  url.searchParams.set("page", String(page));
  const res = await fetch(url, { headers: { "Access-Token": token } });
  return await res.json().catch(() => ({}));
}

async function fetchAdgroups(token: string, advertiser_id: string): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  while (true) {
    const j = await fetchAdgroupsRaw(token, advertiser_id, page);
    if (j.code !== 0) throw new Error(`adgroup/get: ${j.message ?? j.code}`);
    const list = (j.data?.list ?? []) as { adgroup_id: string }[];
    for (const x of list) if (x.adgroup_id) ids.push(String(x.adgroup_id));
    const pi = j.data?.page_info;
    const totalPage = Number(pi?.total_page ?? 1);
    if (page >= totalPage || list.length === 0) break;
    page += 1;
    await sleep(150);
  }
  return ids;
}


function toStartTs(d: string) {
  // TikTok comment/list/ requires "YYYY-MM-DD HH:MM:SS"
  return /\d{2}:\d{2}:\d{2}/.test(d) ? d : `${d} 00:00:00`;
}
function toEndTs(d: string) {
  return /\d{2}:\d{2}:\d{2}/.test(d) ? d : `${d} 23:59:59`;
}

async function fetchPage(
  token: string,
  advertiser_id: string,
  search_value: string,
  page: number,
  start_time: string,
  end_time: string,
  page_size = 100,
  search_field = "ADGROUP_ID",
) {
  const url = new URL(`${TT}/comment/list/`);
  url.searchParams.set("advertiser_id", advertiser_id);
  url.searchParams.set("search_field", search_field);
  url.searchParams.set("search_value", search_value);
  url.searchParams.set("start_time", toStartTs(start_time));
  url.searchParams.set("end_time", toEndTs(end_time));
  url.searchParams.set("comment_type", JSON.stringify(["ALL"]));
  url.searchParams.set("sort_field", "CREATE_TIME");
  url.searchParams.set("sort_type", "DESC");
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(page_size));
  const res = await fetch(url, { headers: { "Access-Token": token } });
  return await res.json().catch(() => ({}));
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "comments");
    const {
      advertiser_ids: filterIds,
      max_pages = 10,
      days = 30,
      start_date,
      end_date,
      incremental = true,
      debug = false,
    } = (await req.json().catch(() => ({}))) as {
      advertiser_ids?: string[];
      max_pages?: number;
      days?: number;
      start_date?: string;
      end_date?: string;
      incremental?: boolean;
      debug?: boolean;
    };

    const endDate = end_date ?? fmtDate(new Date());
    const reqStartDate =
      start_date ?? fmtDate(new Date(Date.now() - Math.max(1, days) * 86400 * 1000));

    const db = admin();
    const [{ data: conns, error: cErr }, { data: acRows, error: aErr }, { data: stateRows }] =
      await Promise.all([
        db.from("tiktok_connections").select("*"),
        db.from("advertiser_countries").select("advertiser_id, country"),
        db.from("tiktok_comment_sync_state").select("advertiser_id, last_synced_until"),
      ]);
    if (cErr) throw new Error(cErr.message);
    if (aErr) throw new Error(aErr.message);

    const countryByAdv = new Map<string, string>(
      ((acRows ?? []) as { advertiser_id: string; country: string }[]).map((r) => [
        r.advertiser_id,
        r.country,
      ]),
    );
    const lastByAdv = new Map<string, string>();
    for (const s of (stateRows ?? []) as { advertiser_id: string; last_synced_until: string | null }[]) {
      if (s.last_synced_until) lastByAdv.set(s.advertiser_id, s.last_synced_until.slice(0, 10));
    }

    const tokenByAdv = new Map<string, string>();
    for (const c of (conns ?? []) as ConnRow[])
      for (const id of c.advertiser_ids)
        if (!tokenByAdv.has(id)) tokenByAdv.set(id, c.access_token);

    const targets = (filterIds && filterIds.length ? filterIds : [...tokenByAdv.keys()]).filter(
      (id) => tokenByAdv.has(id),
    );
    const { data: existingCommentRows } = targets.length
      ? await db.from("tiktok_comments").select("advertiser_id").in("advertiser_id", targets)
      : { data: [] };
    const hasStoredComments = new Set(
      ((existingCommentRows ?? []) as { advertiser_id: string }[]).map((r) => r.advertiser_id),
    );

    const errors: { advertiser_id: string; error: string }[] = [];
    const nowIso = new Date().toISOString();
    let totalUpserted = 0;

    for (const advId of targets) {
      const token = tokenByAdv.get(advId)!;
      // Incremental: bump window start if we already synced past it
      let advStart = reqStartDate;
      if (incremental && hasStoredComments.has(advId)) {
        const last = lastByAdv.get(advId);
        const nextAfterLast = last ? addDays(last, 1) : "";
        if (nextAfterLast && daysBetween(nextAfterLast, advStart) < 0) advStart = nextAfterLast;
      }
      const windows = splitWindows(advStart, endDate, 30);

      const advRows: CommentRow[] = [];
      let advHadError = false;
      try {
        const adgroups = await fetchAdgroups(token, advId);
        if (debug) {
          const firstAdgroup = adgroups[0] ?? null;
          const [ws, we] = windows[0] ?? [advStart, endDate];
          const sample = firstAdgroup
            ? await fetchPage(token, advId, firstAdgroup, 1, ws, we, 100, "ADGROUP_ID")
            : null;
          const advSample = await fetchPage(token, advId, advId, 1, ws, we, 100, "ADVERTISER_ID");
          return new Response(
            JSON.stringify({
              debug: true,
              advertiser_id: advId,
              country: countryByAdv.get(advId) ?? null,
              requested_start_date: reqStartDate,
              effective_start_date: advStart,
              end_date: endDate,
              incremental,
              has_stored_comments: hasStoredComments.has(advId),
              stored_last_synced_until: lastByAdv.get(advId) ?? null,
              windows,
              adgroup_count: adgroups.length,
              sample_adgroup_id: firstAdgroup,
              sample_response_by_adgroup: sample,
              sample_response_by_advertiser: advSample,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        for (const agId of adgroups) {
          for (const [ws, we] of windows) {
            for (let page = 1; page <= max_pages; page++) {
              const j = await fetchPage(token, advId, agId, page, ws, we);
              if (j.code !== 0) {
                advHadError = true;
                errors.push({
                  advertiser_id: advId,
                  error: `adgroup ${agId} ${ws}~${we}: ${j.message ?? `code=${j.code}`}`,
                });
                break;
              }
              const list = (j.data?.comments ?? []) as Record<string, unknown>[];
              if (!list.length) break;
              for (const c of list) {
                const cid = String(c.comment_id ?? "");
                if (!cid) continue;
                const created = c.create_time;
                let createdIso: string | null = null;
                if (typeof created === "number") createdIso = new Date(created * 1000).toISOString();
                else if (typeof created === "string" && created) {
                  const d = new Date(created);
                  createdIso = isNaN(d.getTime()) ? null : d.toISOString();
                }
                advRows.push({
                  advertiser_id: advId,
                  country: countryByAdv.get(advId) ?? null,
                  comment_id: cid,
                  parent_comment_id: (c.original_comment_id as string) ?? null,
                  vid: (c.tiktok_item_id ?? null) as string | null,
                  text: (c.content ?? null) as string | null,
                  like_count: Number(c.likes ?? 0) || 0,
                  reply_count: Number(c.replies ?? 0) || 0,
                  username: (c.user_name ?? null) as string | null,
                  avatar_url: (c.user_avatar_url ?? null) as string | null,
                  comment_type: (c.comment_type ?? null) as string | null,
                  comment_create_time: createdIso,
                  pulled_at: nowIso,
                });
              }
              const pi = j.data?.page_info;
              const totalPage = Number(pi?.total_page ?? 1);
              if (page >= totalPage) break;
              await sleep(200);
            }
            await sleep(120);
          }
          await sleep(120);
        }
      } catch (e) {
        advHadError = true;
        errors.push({ advertiser_id: advId, error: (e as Error).message });
      }

      if (advRows.length) {
        const CHUNK = 500;
        for (let i = 0; i < advRows.length; i += CHUNK) {
          const batch = advRows.slice(i, i + CHUNK);
          const { error } = await db
            .from("tiktok_comments")
            .upsert(batch, { onConflict: "comment_id" });
          if (error) throw new Error(error.message);
          totalUpserted += batch.length;
        }
      }
      // Only advance sync cursor when this advertiser had no API errors and produced rows,
      // otherwise a failed/empty first run can incorrectly skip the historical backfill.
      if (!advHadError && advRows.length > 0) {
        await db.from("tiktok_comment_sync_state").upsert(
          { advertiser_id: advId, last_synced_until: `${endDate}T23:59:59Z`, last_run_at: nowIso },
          { onConflict: "advertiser_id" },
        );
      }

      await sleep(300);
    }

    return new Response(
      JSON.stringify({
        advertisers: targets.length,
        upserted: totalUpserted,
        start_date: reqStartDate,
        end_date: endDate,
        errors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("tiktok-comments-sync", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
