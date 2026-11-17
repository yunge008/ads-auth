// 海外仓库存接口：千易 ERP（MY/PH）、顶妙WMS / TOPWMS（TH1）。只读。
//
// 千易（https://open.qianyierp.com/zh-CN/ ，2026-11-17 拉取）
//   POST https://{host}/api/v1/{path}，multipart/form-data；公共参数 appId / serviceType / bizParam(JSON 字符串) / timestamp(毫秒) / sign
//   sign = md5("appId=" + appId + "bizParam=" + bizParam + "serviceType=" + serviceType + "timestamp=" + ts + appSecret)，32 位小写
//   响应 {errorCode:"0"|"", state:"success"|"failure", errorMsg, bizContent:"<JSON 字符串>"}
//   host：国内 www.qianyierp.com / 海外 asia.qianyierp.com；本账号是海外站，默认先 asia，APP_NOT_EXIST 时再试 www
//   库存：path=inventory, serviceType=QUERY_SIMPLE_LIST_INVENTORY_V2, bizParam {warehouse:<千易仓库名称>, page, pageSize≤200, showEmpty}
//         → result[] {sku, skuName, warehouse, total, available(可用量), allocated, unavailable, …}
//   仓库：path=warehouse, serviceType=QUERY_WAREHOUSE_LIST → result[] {id, name, code, country, status, kind}
//   ERP 页面上的 accessId / secretKey 即文档里的 appId / appSecret。
//   注意：文档给的签名示例值（b3dfeed4…）按文档算法复现不出来，算法以文字描述为准，需实测确认。
//
// 顶妙WMS（https://s.apifox.cn/422721aa-3e4e-48b3-89dd-eae8192f22ac ，2026-11-17 拉取）
//   POST {baseUrl}{uri}，application/json；baseUrl 文档里打码为 https://xxxxxxxxxx/api/open/erp，需找 WMS 对接人要
//   header AppKey / Signature；Signature = md5(md5(body原文) + appSecret)
//   body 公共参数 requestTimestamp(秒) / source(接入的 ERP 名称，找 WMS 对接人获取)
//   响应 {result:"success"|"fail", code, message, data, reason}；分页 cursor，pageSize ≤ 100；限频 300 次/分钟
//   库存：/goods_sku_warehouse/search_page {warehouseId, pageSize, cursor, isShowAllStock:1}
//         → data.list[] {goodsSkuOuterId(商品SKU), availableStockNum(可用), lockedStockNum(预占), onWayNum, faultyStockNum, …}
//   仓库：/warehouse/get_list → data.list[] {warehouseId, warehouseCode, warehouseName, areaCode}
import { md5 } from "./md5.ts";

export type StockRow = { wh_sku: string; available: number; on_hand: number | null; product_name: string | null };
export type ProviderWarehouse = { ref: string; name: string; code: string | null; country: string | null; status: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

// ═══ 千易 ═══════════════════════════════════════════════════════════════════
export function qianyiSign(appId: string, serviceType: string, bizParam: string, timestamp: number | string, appSecret: string): string {
  return md5(`appId=${appId}bizParam=${bizParam}serviceType=${serviceType}timestamp=${timestamp}${appSecret}`);
}

function qianyiCreds() {
  const appId = Deno.env.get("QIANYI_ACCESS_ID") ?? "";
  const secret = Deno.env.get("QIANYI_SECRET_KEY") ?? "";
  if (!appId || !secret) throw new Error("千易未配置：Supabase secrets 缺 QIANYI_ACCESS_ID / QIANYI_SECRET_KEY（千易ERP → 设置 → 三方应用对接 里的 accessId / secretKey）");
  const env = (Deno.env.get("QIANYI_HOST") ?? "").trim();
  const hosts = env ? [env] : ["asia.qianyierp.com", "www.qianyierp.com"]; // 负责人确认（2026-11-17）：账号在海外站
  return { appId, secret, hosts };
}

let qianyiHostOk: string | null = null;

export async function qianyiCall<T = unknown>(path: string, serviceType: string, biz: Record<string, unknown>): Promise<T> {
  const { appId, secret, hosts } = qianyiCreds();
  const order = qianyiHostOk ? [qianyiHostOk, ...hosts.filter((h) => h !== qianyiHostOk)] : hosts;
  const bizParam = JSON.stringify(biz);
  let lastErr = "";
  for (const host of order) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ts = Date.now();
      const fd = new FormData();
      fd.set("appId", appId);
      fd.set("serviceType", serviceType);
      fd.set("bizParam", bizParam);
      fd.set("timestamp", String(ts));
      fd.set("sign", qianyiSign(appId, serviceType, bizParam, ts, secret));
      let j: { errorCode?: string; errorMsg?: string; state?: string; bizContent?: string } = {};
      let status = 0;
      try {
        const r = await fetch(`https://${host}/api/v1/${path}`, { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
        status = r.status;
        const text = await r.text();
        try { j = JSON.parse(text); } catch { j = { state: "failure", errorMsg: text.slice(0, 300) }; }
      } catch (e) {
        lastErr = `${host} 网络错误：${(e as Error).message}`;
        await sleep(1000 * attempt);
        continue;
      }
      if (j.state === "success" && (!j.errorCode || j.errorCode === "0")) {
        qianyiHostOk = host;
        const bc = j.bizContent ?? "{}";
        return (typeof bc === "string" ? JSON.parse(bc) : bc) as T;
      }
      lastErr = `${host} ${serviceType} 失败：http=${status} errorCode=${j.errorCode ?? ""} ${j.errorMsg ?? ""}`.trim();
      if (j.errorCode === "APP_NOT_EXIST") break; // 换下一个环境
      if (status === 429 || /limit|频/i.test(j.errorMsg ?? "")) { await sleep(2000 * attempt); continue; }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "千易接口调用失败");
}

export async function qianyiWarehouses(): Promise<ProviderWarehouse[]> {
  const out: ProviderWarehouse[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await qianyiCall<{ result?: Array<Record<string, unknown>>; total?: number }>("warehouse", "QUERY_WAREHOUSE_LIST", { page, pageSize: 200 });
    const list = r.result ?? [];
    for (const w of list) {
      out.push({ ref: String(w.name ?? ""), name: String(w.name ?? ""), code: w.code ? String(w.code) : null, country: w.country ? String(w.country) : null, status: w.status ? String(w.status) : null });
    }
    if (!list.length || out.length >= int(r.total)) break;
  }
  return out;
}

/** 按千易仓库名称拉全部 SKU 库存（含 0 库存，便于区分「仓库无货」和「编码对不上」） */
export async function qianyiInventory(warehouseName: string): Promise<{ rows: StockRow[]; notes: string[] }> {
  if (!warehouseName) throw new Error("千易仓库名称未配置（仓库卡片里「仓库系统仓库」选择对应仓库）");
  const rows: StockRow[] = [];
  const notes: string[] = [];
  let total = 0;
  for (let page = 1; page <= 500; page++) {
    const r = await qianyiCall<{ result?: Array<Record<string, unknown>>; total?: number }>("inventory", "QUERY_SIMPLE_LIST_INVENTORY_V2", {
      warehouse: warehouseName, page, pageSize: 200, showEmpty: true, showCombine: false,
    });
    const list = r.result ?? [];
    total = int(r.total);
    for (const x of list) {
      if (x.warehouse && String(x.warehouse) !== warehouseName) continue;
      rows.push({ wh_sku: String(x.sku ?? "").trim(), available: int(x.available), on_hand: x.total === undefined ? null : int(x.total), product_name: x.skuName ? String(x.skuName) : null });
    }
    if (!list.length || page * 200 >= total) break;
  }
  if (total && rows.length !== total) notes.push(`千易返回 total=${total}，实际取到 ${rows.length} 行`);
  return { rows, notes };
}

// ═══ 顶妙WMS ═════════════════════════════════════════════════════════════════
export function dingmiaoSign(body: string, appSecret: string): string {
  return md5(md5(body) + appSecret);
}

function dingmiaoCreds() {
  const base = (Deno.env.get("DINGMIAO_BASE_URL") ?? "").trim().replace(/\/+$/, "");
  const appKey = Deno.env.get("DINGMIAO_APP_KEY") ?? "";
  const secret = Deno.env.get("DINGMIAO_APP_SECRET") ?? "";
  const source = Deno.env.get("DINGMIAO_SOURCE") ?? "";
  const miss = [!base && "DINGMIAO_BASE_URL（接口地址，文档里打码，找 WMS 对接人要，形如 https://域名/api/open/erp）", !appKey && "DINGMIAO_APP_KEY", !secret && "DINGMIAO_APP_SECRET", !source && "DINGMIAO_SOURCE（接入的 ERP 名称，找 WMS 对接人要）"].filter(Boolean);
  if (miss.length) throw new Error(`顶妙WMS 未配置：Supabase secrets 缺 ${miss.join("、")}`);
  return { base, appKey, secret, source };
}

let dmLast = 0;
export async function dingmiaoCall<T = unknown>(uri: string, biz: Record<string, unknown>): Promise<T> {
  const { base, appKey, secret, source } = dingmiaoCreds();
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = dmLast + 250 - Date.now(); // 300 次/分钟 → ≥ 200ms 间隔，留余量
    if (wait > 0) await sleep(wait);
    dmLast = Date.now();
    const body = JSON.stringify({ ...biz, requestTimestamp: Math.floor(Date.now() / 1000), source });
    let j: { result?: string; code?: string; message?: string; reason?: string; data?: T } = {};
    let status = 0;
    try {
      const r = await fetch(`${base}${uri}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", AppKey: appKey, Signature: dingmiaoSign(body, secret) },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      status = r.status;
      const text = await r.text();
      try { j = JSON.parse(text); } catch { j = { result: "fail", reason: text.slice(0, 300) }; }
    } catch (e) {
      lastErr = `网络错误：${(e as Error).message}`;
      await sleep(1000 * attempt);
      continue;
    }
    if (j.result === "success") return j.data as T;
    lastErr = `顶妙WMS ${uri} 失败：http=${status} ${j.reason ?? j.message ?? ""}`.trim();
    if (status === 429 || /频|limit/i.test(lastErr)) { await sleep(5000 * attempt); continue; }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

export async function dingmiaoWarehouses(): Promise<ProviderWarehouse[]> {
  const d = await dingmiaoCall<{ list?: Array<Record<string, unknown>> }>("/warehouse/get_list", {});
  return (d?.list ?? []).map((w) => ({ ref: String(w.warehouseId ?? ""), name: String(w.warehouseName ?? ""), code: w.warehouseCode ? String(w.warehouseCode) : null, country: w.areaCode ? String(w.areaCode) : null, status: null }));
}

export async function dingmiaoInventory(warehouseId: string): Promise<{ rows: StockRow[]; notes: string[] }> {
  if (!warehouseId) throw new Error("顶妙WMS 仓库 ID 未配置（仓库卡片里「仓库系统仓库」选择对应仓库）");
  const rows: StockRow[] = [];
  const notes: string[] = [];
  let cursor = "";
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const d = await dingmiaoCall<{ list?: Array<Record<string, unknown>>; total?: number; cursor?: string }>("/goods_sku_warehouse/search_page", {
      warehouseId, pageSize: 100, isShowAllStock: 1, ...(cursor ? { cursor } : {}),
    });
    const list = d?.list ?? [];
    total = int(d?.total);
    for (const x of list) {
      if (x.warehouseId !== undefined && String(x.warehouseId) !== warehouseId) continue;
      const av = int(x.availableStockNum);
      rows.push({ wh_sku: String(x.goodsSkuOuterId ?? "").trim(), available: av, on_hand: av + int(x.lockedStockNum), product_name: null });
    }
    const next = String(d?.cursor ?? "");
    if (!list.length || !next || next === cursor) break;
    cursor = next;
  }
  if (total && rows.length !== total) notes.push(`顶妙返回 total=${total}，实际取到 ${rows.length} 行`);
  return { rows, notes };
}
