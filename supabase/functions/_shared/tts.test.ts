// TikTok Shop 签名等纯函数测试。
// 跑法：deno test supabase/functions/_shared/tts.test.ts
//
// 签名用例取自官方文档 "Sign your API request" 的分步示例（app_secret=e59af819cc，
// Get Authorized Shops，期望 sign=b596b73e…）。这个值能对上，说明拼串顺序、HMAC key、hex 小写都和平台一致。
import { normalizeHandle, pctToRate, ttsSign } from "./tts.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + "：" : ""}实际 ${JSON.stringify(actual)} ≠ 预期 ${JSON.stringify(expected)}`);
  }
}

Deno.test("ttsSign: 官方文档示例（GET，无 body）", async () => {
  const sign = await ttsSign(
    "/authorization/202309/shops",
    { app_key: "29a39d", timestamp: "1623812664" },
    "",
    "e59af819cc",
  );
  assertEquals(sign, "b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8");
});

Deno.test("ttsSign: sign / access_token 不参与签名，key 按字母序", async () => {
  const a = await ttsSign("/p", { timestamp: "1", app_key: "k" }, "", "s");
  const b = await ttsSign("/p", { app_key: "k", timestamp: "1", sign: "x", access_token: "y" }, "", "s");
  assertEquals(a, b);
});

Deno.test("ttsSign: body 原文参与签名", async () => {
  const a = await ttsSign("/p", { app_key: "k" }, '{"a":1}', "s");
  const b = await ttsSign("/p", { app_key: "k" }, '{"a": 1}', "s");
  if (a === b) throw new Error("body 空白不同签名应不同");
});

Deno.test("normalizeHandle", () => {
  assertEquals(normalizeHandle(" @Foo.Bar "), "foo.bar");
  assertEquals(normalizeHandle("@@abc"), "abc");
  assertEquals(normalizeHandle("a b"), "ab");
});

Deno.test("pctToRate: 10% → 1000，35.87% → 3587", () => {
  assertEquals(pctToRate(10), 1000);
  assertEquals(pctToRate(35.87), 3587);
  assertEquals(pctToRate(1), 100);
});

Deno.test("只读闸门：放行定向计划与达人私信，拦截审样/删除计划/冲突处理", async () => {
  const { ttsAccessCheck } = await import("./tts.ts");
  const ok = (m: string, p: string) => ttsAccessCheck(m, p) === null;
  const cases: Array<[string, string, boolean]> = [
    ["GET", "/order/202309/orders", true],
    ["POST", "/order/202309/orders/search", true],
    ["POST", "/return_refund/202602/returns/search", true],
    ["POST", "/affiliate_seller/202508/target_collaborations", true],
    ["PUT", "/affiliate_seller/202508/target_collaborations/123", true],
    ["POST", "/affiliate_seller/202508/conversations", true],
    ["POST", "/affiliate_seller/202412/conversations/abc123/messages", true],
    ["POST", "/affiliate_seller/202412/conversatons/read", true],
    ["POST", "/affiliate_seller/202608/conversations/abc/status", false],
    ["POST", "/affiliate_seller/202507/sample_applications/1/review", false],
    ["DELETE", "/affiliate_seller/202409/target_collaborations/1", false],
    ["POST", "/affiliate_seller/202605/target_collaborations/conflicts/resolve", false],
    ["POST", "/affiliate_seller/202509/target_collaboration/1/link", false],
  ];
  for (const [m, p, want] of cases) {
    if (ok(m, p) !== want) throw new Error(`${m} ${p} 期望 ${want ? "放行" : "拦截"}`);
  }
});
