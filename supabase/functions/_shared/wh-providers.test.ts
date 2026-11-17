// 跑法：deno test supabase/functions/_shared/wh-providers.test.ts
// 期望值由 Python hashlib 独立计算。
import { md5 } from "./md5.ts";
import { dingmiaoInventory, dingmiaoSign, qianyiInventory, qianyiSign } from "./wh-providers.ts";

function eq(a: unknown, b: unknown, msg = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb} got ${sa}`);
}

Deno.test("md5：标准向量 + 中文多块", () => {
  eq(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  eq(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  eq(md5("测试仓库".repeat(30)), "595193b226678362acb6f9eb049130c7");
});

Deno.test("千易签名：appId=…bizParam=…serviceType=…timestamp=…+appSecret", () => {
  eq(qianyiSign("QY177501", "QUERY_SIMPLE_LIST_INVENTORY_V2", '{"warehouse":"MY仓","page":1}', 1763366400000, "SECRET"), "9b72cabac1ae6833e87ac876010a5c04");
  // 文档示例按文字算法得 46bc…（文档给的 b3dfeed4… 复现不出，以实测为准）
  eq(qianyiSign("openApi_TEST", "CREATE_ASN_ORDER", '{"asnSkuVOList":[{"expectQuantity":"100","sku":"SKU1230"}],"warehouseName":"测试仓库"}', 1662448537275, "openApi_TOKEN"), "46bc640fe3d0e2866afde2980fe85392");
});

Deno.test("顶妙签名：md5(md5(body)+appSecret)", () => {
  eq(dingmiaoSign('{"warehouseId":"1","pageSize":100}', "SECRET"), "0f29c2a1947695a8d5c94b748f8023bf");
});

function withFetch(handler: (url: string, init: RequestInit) => unknown, env: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const orig = globalThis.fetch;
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    globalThis.fetch = ((url: string, init: RequestInit) => Promise.resolve(new Response(JSON.stringify(handler(String(url), init))))) as typeof fetch;
    try { await fn(); } finally {
      globalThis.fetch = orig;
      for (const k of Object.keys(env)) Deno.env.delete(k);
    }
  };
}

Deno.test("千易库存：分页取完、过滤其他仓、APP_NOT_EXIST 换海外环境", withFetch((url, init) => {
  const fd = init.body as FormData;
  if (url.includes("www.")) return { state: "failure", errorCode: "APP_NOT_EXIST", errorMsg: "appId不存在" };
  const biz = JSON.parse(String(fd.get("bizParam")));
  if (fd.get("sign") !== qianyiSign("ID", String(fd.get("serviceType")), String(fd.get("bizParam")), String(fd.get("timestamp")), "S")) throw new Error("sign 不对");
  const all = Array.from({ length: 250 }, (_, i) => ({ sku: `S${i}`, available: i % 7, total: i % 7 + 1, warehouse: "MY仓" }));
  all.push({ sku: "X", available: 9, total: 9, warehouse: "别的仓" });
  const page = all.slice((biz.page - 1) * 200, biz.page * 200);
  return { state: "success", errorCode: "", bizContent: JSON.stringify({ result: page, total: all.length }) };
}, { QIANYI_ACCESS_ID: "ID", QIANYI_SECRET_KEY: "S" }, async () => {
  const r = await qianyiInventory("MY仓");
  eq(r.rows.length, 250);
  eq(r.rows[8], { wh_sku: "S8", available: 1, on_hand: 2, product_name: null });
  eq(r.notes.length, 1, "total 含别的仓 1 行，提示不一致");
}));

Deno.test("顶妙库存：cursor 翻页、AppKey/Signature 头、公共参数", withFetch((_url, init) => {
  const h = init.headers as Record<string, string>;
  const body = String(init.body);
  if (h.AppKey !== "K" || h.Signature !== dingmiaoSign(body, "S")) throw new Error("签名头不对");
  const b = JSON.parse(body);
  if (b.source !== "ERPX" || !b.requestTimestamp || b.warehouseId !== "3") throw new Error("公共参数缺失");
  const p = b.cursor ? 2 : 1;
  const list = p === 1
    ? Array.from({ length: 100 }, (_, i) => ({ warehouseId: "3", goodsSkuOuterId: `A${i}`, availableStockNum: 2, lockedStockNum: 1 }))
    : [{ warehouseId: "3", goodsSkuOuterId: "B", availableStockNum: 5, lockedStockNum: 0 }];
  return { result: "success", data: { list, total: 101, cursor: p === 1 ? "c1" : "" } };
}, { DINGMIAO_BASE_URL: "https://wms.example/api/open/erp/", DINGMIAO_APP_KEY: "K", DINGMIAO_APP_SECRET: "S", DINGMIAO_SOURCE: "ERPX" }, async () => {
  const r = await dingmiaoInventory("3");
  eq(r.rows.length, 101);
  eq(r.rows[100], { wh_sku: "B", available: 5, on_hand: 5, product_name: null });
  eq(r.notes, []);
}));
