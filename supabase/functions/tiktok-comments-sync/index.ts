// Sync TikTok ad comments for all advertisers across tiktok_connections.
// Body: { advertiser_ids?: string[]; max_pages?: number }  (default: all known; 5 pages each)
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

async function fetchPage(
  token: string,
  advertiser_id: string,
  page: number,
  start_time: string,
  end_time: string,
  page_size = 50,
) {
  const url = new URL(`${TT}/comment/list/`);
  url.searchParams.set("advertiser_id", advertiser_id);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(page_size));
  url.searchParams.set("start_time", start_time);
  url.searchParams.set("end_time", end_time);
  const res = await fetch(url, { headers: { "Access-Token": token } });
  const j = await res.json().catch(() => ({}));
  return j;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "comments");
    const { advertiser_ids: filterIds, max_pages = 5 } = (await req
      .json()
      .catch(() => ({}))) as { advertiser_ids?: string[]; max_pages?: number };

    const db = admin();
    const [{ data: conns, error: cErr }, { data: acRows, error: aErr }] = await Promise.all([
      db.from("tiktok_connections").select("*"),
      db.from("advertiser_countries").select("advertiser_id, country"),
    ]);
    if (cErr) throw new Error(cErr.message);
    if (aErr) throw new Error(aErr.message);

    const countryByAdv = new Map<string, string>(
      ((acRows ?? []) as { advertiser_id: string; country: string }[]).map((r) => [
        r.advertiser_id,
        r.country,
      ]),
    );

    // advertiser_id -> token (first wins)
    const tokenByAdv = new Map<string, string>();
    for (const c of (conns ?? []) as ConnRow[]) {
      for (const id of c.advertiser_ids) {
        if (!tokenByAdv.has(id)) tokenByAdv.set(id, c.access_token);
      }
    }

    const targets = (filterIds && filterIds.length ? filterIds : [...tokenByAdv.keys()]).filter(
      (id) => tokenByAdv.has(id),
    );

    const all: CommentRow[] = [];
    const errors: { advertiser_id: string; error: string }[] = [];
    const nowIso = new Date().toISOString();

    for (const advId of targets) {
      const token = tokenByAdv.get(advId)!;
      try {
        for (let page = 1; page <= max_pages; page++) {
          const j = await fetchPage(token, advId, page);
          if (j.code !== 0) {
            errors.push({ advertiser_id: advId, error: String(j.message ?? `code=${j.code}`) });
            break;
          }
          const list = (j.data?.comments ?? j.data?.list ?? []) as Record<string, unknown>[];
          if (!list.length) break;
          for (const c of list) {
            const cid = String(c.comment_id ?? c.id ?? "");
            if (!cid) continue;
            const created = c.create_time ?? c.comment_create_time;
            let createdIso: string | null = null;
            if (typeof created === "number") createdIso = new Date(created * 1000).toISOString();
            else if (typeof created === "string" && created)
              createdIso = new Date(created).toISOString();
            all.push({
              advertiser_id: advId,
              country: countryByAdv.get(advId) ?? null,
              comment_id: cid,
              parent_comment_id: (c.parent_comment_id as string) ?? null,
              vid: (c.item_id ?? c.video_id ?? c.vid ?? null) as string | null,
              text: (c.text ?? c.content ?? null) as string | null,
              like_count: Number(c.like_count ?? 0) || 0,
              reply_count: Number(c.reply_count ?? 0) || 0,
              username: (c.user_name ?? c.username ?? c.commenter_name ?? null) as string | null,
              avatar_url: (c.avatar_url ?? c.user_avatar ?? null) as string | null,
              comment_type: (c.comment_type ?? c.type ?? null) as string | null,
              comment_create_time: createdIso,
              pulled_at: nowIso,
            });
          }
          const pageInfo = j.data?.page_info ?? j.data?.pagination;
          const total = pageInfo?.total_number ?? pageInfo?.total ?? 0;
          if (page * 50 >= Number(total)) break;
        }
      } catch (e) {
        errors.push({ advertiser_id: advId, error: (e as Error).message });
      }
    }

    let upserted = 0;
    if (all.length) {
      // upsert in chunks
      const CHUNK = 500;
      for (let i = 0; i < all.length; i += CHUNK) {
        const batch = all.slice(i, i + CHUNK);
        const { error } = await db
          .from("tiktok_comments")
          .upsert(batch, { onConflict: "comment_id" });
        if (error) throw new Error(error.message);
        upserted += batch.length;
      }
    }

    return new Response(
      JSON.stringify({ advertisers: targets.length, upserted, errors }),
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
