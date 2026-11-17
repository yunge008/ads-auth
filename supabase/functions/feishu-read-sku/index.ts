// Read "SKU匹配表-TK"（旧名 SKU匹配表）feishu sheet -> upsert sku_product_map. 每晚由 feishu-sync-cron 调用一次。
// Columns (1-indexed): A=国家 B=商品ID C=商品名称 D=SKU ID F=商家SKU
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v))
    return v
      .map((s) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text ?? "") : String(s ?? "")))
      .join("")
      .trim();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return (o.text as string).trim();
  }
  return String(v).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // 每晚 feishu-sync-cron 免口令调用（x-cron-key），否则走原口令校验
    if (!(await cronAuthed(req))) await checkAdminPasscode(req, "material-performance");
    const { sheet_name } = (await req.json().catch(() => ({}))) as {
      sheet_name?: string;
    };
    const db = admin();
    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken("FEISHU_SKU_SPREADSHEET_TOKEN");
    const sheets = await listSheets(token, spreadsheetToken);
    // 2026-11 飞书里改名为「SKU匹配表-TK」（另有 -SP 为 Shopee）；未指定时先找新名，再兼容旧名
    const names = sheet_name ? [sheet_name] : ["SKU匹配表-TK", "SKU匹配表"];
    const sid = names.map((n) => sheets.find((s) => s.title === n)?.sheet_id).find(Boolean);
    if (!sid) throw new Error(`未找到 sheet：${names.join(" / ")}`);
    const data = await readRange(token, spreadsheetToken, `${sid}!A2:F`);

    const rows: Array<{
      country: string;
      product_id: string;
      product_name: string | null;
      sku_id: string | null;
      merchant_sku: string;
    }> = [];
    for (const r of data) {
      const row = r ?? [];
      const country = cellText(row[0]);
      const product_id = cellText(row[1]);
      if (!product_id) continue;
      rows.push({
        country,
        product_id,
        product_name: cellText(row[2]) || null,
        sku_id: cellText(row[3]) || null,
        merchant_sku: cellText(row[5]) || "",
      });
    }

    // Dedupe by unique key (country, product_id, merchant_sku) — last wins
    const dedup = new Map<string, (typeof rows)[number]>();
    for (const r of rows) dedup.set(`${r.country}|${r.product_id}|${r.merchant_sku}`, r);
    const finalRows = Array.from(dedup.values());

    let upserted = 0;
    if (finalRows.length) {
      const CHUNK = 500;
      for (let i = 0; i < finalRows.length; i += CHUNK) {
        const batch = finalRows.slice(i, i + CHUNK);
        const { error } = await db
          .from("sku_product_map")
          .upsert(batch, { onConflict: "country,product_id,merchant_sku" });
        if (error) throw new Error(error.message);
        upserted += batch.length;
      }
    }


    return new Response(JSON.stringify({ upserted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("feishu-read-sku", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
