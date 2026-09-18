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
  // 年在前的写法优先精确匹配：飞书按 ToString 返回时日期是「2024/01/05」「2024-1-5」「2024年1月5日」这类渲染文本，
  // 交给 new Date() 解析在部分格式下会得到错误的月/日顺序，这里先自己拆。
  const ymd = s.match(/^(\d{4})\s*[-/.\u5e74]\s*(\d{1,2})\s*[-/.\u6708]\s*(\d{1,2})/);
  if (ymd) {
    const [, y, mo, dd] = ymd;
    const iso = `${y}-${mo.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const d2 = new Date(`${iso}T00:00:00Z`);
    if (!isNaN(d2.getTime())) return iso;
  }
  // B6：这里原来还有第四层「把 . / 换成 - 再丢给 new Date()」的兜底，已删除。
  // 删的理由：new Date() 对 "03-04-2024" 这类写法会按自己的规则猜月/日顺序，猜错时
  // 返回的是一个**看起来正常**的日期 —— 没有报错、没有告警，保护期和归属转移直接按错的日子算。
  // 现在认不出的格式一律返回 null，由 A4「无日期的登记行不参与归属判定」接住：
  // 该行被跳过并记进 evidence.skippedNoDate，能在审查里看到，而不是静默算错。
  // 要支持新格式，就往上面的精确正则里加一条，不要退回猜测。
  return null;
}
