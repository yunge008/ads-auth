// Read "SKU匹配表" feishu sheet -> upsert sku_product_map.
// Columns (1-indexed): A=国家 B=商品ID C=商品名称 D=SKU ID F=商家SKU
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

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
    await checkAdminPasscode(req, "material-performance");
    const { sheet_name = "SKU匹配表" } = (await req.json().catch(() => ({}))) as {
      sheet_name?: string;
    };
    const db = admin();
    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken("FEISHU_SKU_SPREADSHEET_TOKEN");
    const sheets = await listSheets(token, spreadsheetToken);
    const sid = sheets.find((s) => s.title === sheet_name)?.sheet_id;
    if (!sid) throw new Error(`未找到 sheet：${sheet_name}`);
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

    let upserted = 0;
    if (rows.length) {
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
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
