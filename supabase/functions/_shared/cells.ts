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
