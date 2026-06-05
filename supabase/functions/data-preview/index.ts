// Read-only previews for centrally synced Feishu data.
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

const TABLES = new Set(["staff_vid_map", "sku_product_map", "tiktok_comments"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "feishu-data");
    const body = (await req.json().catch(() => ({}))) as {
      table?: string;
      page?: number;
      page_size?: number;
    };
    const table = (body.table ?? "").trim();
    if (!TABLES.has(table)) throw new Error("table 仅支持 staff_vid_map / sku_product_map / tiktok_comments");
    await checkAdminPasscode(req, table === "tiktok_comments" ? "comments" : "feishu-data");
    const page = Math.max(1, Math.floor(Number(body.page ?? 1)) || 1);
    const pageSize = Math.min(2000, Math.max(20, Math.floor(Number(body.page_size ?? 100)) || 100));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const db = admin();
    const columns = table === "staff_vid_map"
      ? "country,staff_name,vid,source_type,source_sheet,updated_at"
      : table === "sku_product_map"
        ? "country,product_id,product_name,sku_id,merchant_sku,updated_at"
        : "comment_id,advertiser_id,country,vid,text,text_zh,like_count,reply_count,username,avatar_url,comment_type,parent_comment_id,comment_create_time,updated_at";
    const { data, error, count } = await db
      .from(table)
      .select(columns, { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);

    return new Response(JSON.stringify({ table, rows: data ?? [], count: count ?? 0, page, page_size: pageSize }), {
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