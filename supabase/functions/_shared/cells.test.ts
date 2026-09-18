// 飞书单元格解析的纯函数测试。
// 跑法：deno test supabase/functions/_shared/cells.test.ts
//
// 这里主要钉死 B6：parseDate 只认「Excel 序列号」和「年在前的精确写法」两类，
// 其余一律 null。之前还有一层「把 . / 换成 - 再交给 new Date()」的兜底，
// 它对 "03-04-2024" 这类写法会自己猜月/日顺序，猜错时返回的是一个看起来完全正常的日期，
// 没有任何报错 —— 保护期和归属转移直接按错的日子算。宁可 null 让 A4 跳过，也不要猜。
import { cellText, isPrecisionLostNumber, parseDate } from "./cells.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + "：" : ""}实际 ${JSON.stringify(actual)} ≠ 预期 ${JSON.stringify(expected)}`);
  }
}

// ---------- 认得出的写法 ----------

Deno.test("parseDate: Excel 序列号（数字与数字字符串）", () => {
  assertEquals(parseDate(45292), "2024-01-01");
  assertEquals(parseDate("45292"), "2024-01-01");
});

Deno.test("parseDate: 年在前的各种分隔符都精确解析", () => {
  assertEquals(parseDate("2024-01-05"), "2024-01-05");
  assertEquals(parseDate("2024/1/5"), "2024-01-05");
  assertEquals(parseDate("2024.1.5"), "2024-01-05");
  assertEquals(parseDate("2024年1月5日"), "2024-01-05");
  // 带时间的完整时间戳按前缀取日期，不受时区影响
  assertEquals(parseDate("2024-01-05 10:30:00"), "2024-01-05");
  assertEquals(parseDate("2024-01-05T23:59:59Z"), "2024-01-05");
});

// ---------- B6：认不出的一律 null，不猜 ----------

Deno.test("B6: 年不在前的写法返回 null，不猜月/日顺序", () => {
  // 旧兜底会把它当成 3 月 4 日或 4 月 3 日 —— 到底哪个取决于运行时，这正是要删的原因
  assertEquals(parseDate("03-04-2024"), null);
  assertEquals(parseDate("03/04/2024"), null);
  assertEquals(parseDate("5 Jan 2024"), null);
  assertEquals(parseDate("Jan 5, 2024"), null);
});

Deno.test("B6: 空值与垃圾文本返回 null", () => {
  assertEquals(parseDate(null), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate("待补"), null);
  assertEquals(parseDate("—"), null);
});

// ---------- 其余 helper ----------

Deno.test("cellText: 富文本片段拼接后去空白", () => {
  assertEquals(cellText([{ text: " 王姐" }, { text: "好物 " }]), "王姐好物");
  assertEquals(cellText(123), "123");
  assertEquals(cellText(null), "");
});

Deno.test("isPrecisionLostNumber: 19 位 VID 走 JSON number 必然丢精度", () => {
  assertEquals(isPrecisionLostNumber(7180000000000000000), true);
  assertEquals(isPrecisionLostNumber("7180000000000000000"), false);
  assertEquals(isPrecisionLostNumber(20240105), false);
});
