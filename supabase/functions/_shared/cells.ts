// Shared Feishu cell parsing helpers (extracted from feishu-read).

/** Normalize a Feishu cell value (string / number / rich-text segments) to trimmed text. */
export function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  // Feishu rich-text: array of segments { text }
  if (Array.isArray(v)) {
    return v
      .map((s) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text ?? "") : String(s ?? "")))
      .join("")
      .trim();
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return (o.text as string).trim();
  }
  return String(v).trim();
}

/**
 * 飞书把「看起来是数字」的单元格按 JSON number 返回，而 JS number 只有 2^53 精度。
 * 19 位的 TikTok VID（≈7.1e18）一旦走这条路，末尾几位必被改写成 0——字符串形态仍然是
 * 「7 开头 19 位」、正则照样通过，但值已经是错的，归因时 VID 强匹配会 100% 落空且毫无提示。
 * 这个函数用来在源头识别这种单元格：真要修得把飞书那一列设成「文本」格式。
 */
export function isPrecisionLostNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER;
}

/** Parse a Feishu date cell (Excel serial number or common date strings) to 'YYYY-MM-DD'. */
export function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  // Excel serial number (Feishu returns numbers for date cells)
  if (typeof v === "number" && isFinite(v) && v > 1 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = cellText(v);
  if (!s) return null;
  // Numeric string serial
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1 && n < 100000) {
      const ms = Math.round((n - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  // Common date strings
  const norm = s.replace(/[./]/g, "-");
  const d = new Date(norm);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
