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
