// TikTok Shop 店铺固定内容导出（只读）。前端分片续跑：首次不带 cursor，返回 {columns, rows, next_cursor}；
// next_cursor 非空就原样带回继续调，直到为 null，前端再拼成和卖家后台导出一致列名的 xlsx。
//
// kind：
//   orders     月度订单（按下单时间、店铺本地时区），列名/顺序 = 后台「订单导出」CSV，一行一个 SKU
//   finance    月度财务结算（按结算单生成时间、店铺本地时区），列名 = 后台「订单详情」页签，一行一笔交易（订单维度）
//              另返回 statements（= 后台「对账单」页签）
//   products   最新商品信息（在售），列名 = 后台「批量编辑-全部信息」模板，最右加「活动价」（来自 activity_id 指定的活动）
//   affiliate  月度联盟订单（按下单时间），SKU 级；前端按 group 字段拆成「达人」「服务商」两张表
//   samples    待审申样 + 审核建议（推荐批准 / 待审核 / 不批准），只读，不调审样接口
//
// 所有 TTS 调用都经 _shared/tts.ts 的只读闸门；本函数只用 GET 和 /search 类 POST。
// 订单导出另用 Search Returns 补退货件数/退款金额/Return/Refund 标记，用 Get Warehouse List 补仓库名称。
// 鉴权：requireAdmin（与 tts-p0-probe 一致，仅管理员）。
import { admin, requireAdmin } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { ttsCall, type TtsResult } from "../_shared/tts.ts";

type Shop = { shop_id: string; shop_cipher: string; shop_name: string | null; region: string | null; access_token: string };
type Cell = string | number | null;
type Chunk = {
  kind: string;
  columns: string[];
  rows: Cell[][];
  next_cursor: Record<string, unknown> | null;
  progress: { done: number; total: number | null; unit: string };
  meta?: Record<string, unknown>;
  errors: string[];
};

// Supabase Edge Function 单次请求上限约 150s；软线后不再开新页，留足返回时间。
const SOFT_MS = 45_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function bad(msg: string): never {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  throw e;
}
function apiErr(name: string, r: TtsResult): string {
  return `${name} 失败：http=${r.http_status} code=${r.code} ${r.message} request_id=${r.request_id}`;
}

async function loadShop(shopId: unknown): Promise<Shop> {
  const id = String(shopId ?? "").trim();
  if (!id) bad("shop_id 必填");
  const { data, error } = await admin().from("tts_shops").select("shop_id,shop_cipher,shop_name,region,access_token").eq("shop_id", id).maybeSingle();
  if (error) throw error;
  if (!data) bad(`tts_shops 里没有 shop_id=${id}`);
  return data as Shop;
}

// ── 时间 ────────────────────────────────────────────────────────────────────
const REGION_UTC_OFFSET: Record<string, number> = { PH: 8, MY: 8, SG: 8, TH: 7, VN: 7, ID: 7, JP: 9, GB: 0, US: -8, MX: -6, BR: -3 };
function offsetOf(shop: Shop): number {
  const off = REGION_UTC_OFFSET[(shop.region ?? "").toUpperCase()];
  if (off === undefined) bad(`未配置 ${shop.region} 的时区`);
  return off;
}
/** month=YYYY-MM（店铺本地时区）→ [from, to) 秒级时间戳 */
function monthWindow(shop: Shop, month: unknown) {
  const m = String(month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) bad("month 格式应为 YYYY-MM");
  const [y, mo] = m.split("-").map(Number);
  const off = offsetOf(shop);
  const from = Date.UTC(y, mo - 1, 1) / 1000 - off * 3600;
  const to = Date.UTC(y, mo, 1) / 1000 - off * 3600;
  return { from, to, off };
}
const p2 = (n: number) => String(n).padStart(2, "0");
/** 和后台导出一致的时间文本：PH 为 MM/DD/YYYY h:mm:ss AM/PM，TH 等为 DD/MM/YYYY HH:mm:ss（店铺本地时区） */
function fmtTime(ts: unknown, shop: Shop): string {
  const n = Number(ts ?? 0);
  if (!n) return "";
  const d = new Date((n + offsetOf(shop) * 3600) * 1000);
  const Y = d.getUTCFullYear(), M = p2(d.getUTCMonth() + 1), D = p2(d.getUTCDate());
  const h = d.getUTCHours(), mi = p2(d.getUTCMinutes()), s = p2(d.getUTCSeconds());
  if ((shop.region ?? "").toUpperCase() === "PH") {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${M}/${D}/${Y} ${h12}:${mi}:${s} ${h < 12 ? "AM" : "PM"}`;
  }
  return `${D}/${M}/${Y} ${p2(h)}:${mi}:${s}`;
}
function fmtDate(ts: unknown, shop: Shop): string {
  const n = Number(ts ?? 0);
  if (!n) return "";
  const d = new Date((n + offsetOf(shop) * 3600) * 1000);
  return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`;
}

// ── 金额（按分计算，避免浮点误差）────────────────────────────────────────────
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100) || 0;
const money = (c: number) => Number((c / 100).toFixed(2));
const num = (v: unknown): Cell => (v === undefined || v === null || v === "" ? null : Number(v));
const amt = (o: unknown): Cell => num((o as { amount?: string } | undefined)?.amount);
const pct = (rate: unknown): string => (rate === undefined || rate === null || rate === "" ? "" : `${Number(rate) / 100}%`);

// ═══ 1. 订单 ═══════════════════════════════════════════════════════════════
export const ORDER_COLUMNS = [
  "Order ID", "Order Status", "Order Substatus", "Cancelation/Return Type", "Normal or Pre-order", "SKU ID", "Seller SKU", "Product Name",
  "Variation", "Quantity", "Sku Quantity of return", "SKU Unit Original Price", "SKU Subtotal Before Discount", "SKU Platform Discount",
  "SKU Seller Discount", "SKU Subtotal After Discount", "Shipping Fee After Discount", "Original Shipping Fee", "Shipping Fee Seller Discount",
  "Shipping Fee Platform Discount", "Payment platform discount", "Taxes", "Order Amount", "Order Refund Amount", "Created Time", "Paid Time",
  "RTS Time", "Shipped Time", "Delivered Time", "Cancelled Time", "Cancel By", "Cancel Reason", "Fulfillment Type", "Warehouse Name",
  "Tracking ID", "Delivery Option", "Shipping Provider Name", "Buyer Message", "Buyer Username", "Recipient", "Phone #", "Country", "Region",
  "Province", "Municipality", "Barangay", "Detail Address", "Additional address information", "Payment Method", "Weight(kg)",
  "Product Category", "Package ID", "Seller Note", "Checked Status", "Checked Marked by", "Order Channel", "Creator Handle",
];
// TH 后台导出的地址列和 PH 不同（Zipcode/District，没有 Region/Municipality/Barangay）
const ORDER_COLUMNS_TH = ORDER_COLUMNS.flatMap((c) =>
  c === "Phone #" ? ["Phone #", "Zipcode"]
  : c === "Region" || c === "Municipality" || c === "Barangay" ? []
  : c === "Province" ? ["Province", "District"]
  : [c]
);
// 已在 10 月数据中见过的：COMPLETED/CANCELLED/IN_TRANSIT/DELIVERED；其余为按含义翻译，未核验
const ORDER_STATUS: Record<string, [string, string]> = {
  UNPAID: ["未付款", "未付款"], ON_HOLD: ["待发货", "待处理"], AWAITING_SHIPMENT: ["待发货", "待发货"],
  PARTIALLY_SHIPPING: ["待发货", "部分发货"], AWAITING_COLLECTION: ["待发货", "待揽收"], IN_TRANSIT: ["已发货", "运输中"],
  DELIVERED: ["已发货", "已送达"], COMPLETED: ["已完成", "已完成"], CANCELLED: ["已取消", "已取消"],
};
const CANCEL_BY: Record<string, string> = { BUYER: "User", SELLER: "Seller", SYSTEM: "System", OPERATOR: "Operator" };
const FULFILL: Record<string, string> = { FULFILLMENT_BY_SELLER: "Fulfillment by seller", FULFILLMENT_BY_TIKTOK: "Fulfillment by TikTok" };

type LineItem = {
  sku_id?: string; seller_sku?: string; product_name?: string; sku_name?: string; sku_type?: string;
  original_price?: string; sale_price?: string; seller_discount?: string; platform_discount?: string;
};
type Order = {
  id: string; status?: string; create_time?: number; paid_time?: number; rts_time?: number; collection_time?: number; delivery_time?: number;
  cancel_time?: number; cancellation_initiator?: string; cancel_reason?: string; fulfillment_type?: string; tracking_number?: string;
  delivery_option_name?: string; shipping_provider?: string; buyer_message?: string; payment_method_name?: string; seller_note?: string;
  packages?: Array<{ id?: string }>; line_items?: LineItem[]; payment?: Record<string, string>; warehouse_id?: string;
  recipient_address?: { postal_code?: string; district_info?: Array<{ address_level?: string; address_name?: string }> };
};

/** 退货退款（Search Returns）按订单汇总：每个 SKU 的退货件数、退款金额（分） */
type ReturnInfo = Map<string, { qty: number; refund: number }>;
type Enrich = { warehouses: Map<string, string>; returns: Map<string, ReturnInfo> };

async function warehouseNames(shop: Shop, errors: string[]): Promise<Map<string, string>> {
  const r = await ttsCall<{ warehouses?: Array<{ id?: string; name?: string }> }>({
    method: "GET", path: "/logistics/202309/warehouses", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
  });
  if (r.code !== 0) { errors.push(apiErr("warehouses", r)); return new Map(); }
  return new Map((r.data?.warehouses ?? []).map((w) => [w.id ?? "", w.name ?? ""]));
}

type ReturnOrder = {
  order_id?: string; return_status?: string; return_type?: string;
  return_line_items?: Array<{ sku_id?: string; refund_amount?: { refund_total?: string } }>;
};
/** 按订单号查退货退款单；被拒绝/已取消的申请不计（口径待与后台 Cancelation/Return Type 核对） */
async function returnsFor(shop: Shop, orderIds: string[], errors: string[]): Promise<Map<string, ReturnInfo>> {
  const out = new Map<string, ReturnInfo>();
  if (!orderIds.length) return out;
  let tok = "";
  do {
    const r = await ttsCall<{ return_orders?: ReturnOrder[]; next_page_token?: string }>({
      method: "POST", path: "/return_refund/202602/returns/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { page_size: 50, page_token: tok }, body: { order_ids: orderIds },
    });
    if (r.code !== 0) { errors.push(apiErr("returns/search", r)); break; }
    for (const ro of r.data?.return_orders ?? []) {
      if (/REJECT|CANCEL/i.test(ro.return_status ?? "") || !ro.order_id) continue;
      const m = out.get(ro.order_id) ?? new Map();
      for (const li of ro.return_line_items ?? []) {
        const k = li.sku_id ?? "";
        const a = m.get(k) ?? { qty: 0, refund: 0 };
        a.qty++; a.refund += cents(li.refund_amount?.refund_total);
        m.set(k, a);
      }
      out.set(ro.order_id, m);
    }
    tok = r.data?.next_page_token ?? "";
  } while (tok);
  return out;
}

function orderRows(o: Order, shop: Shop, th: boolean, en?: Enrich): Cell[][] {
  const p = o.payment ?? {};
  const [st, sub] = ORDER_STATUS[o.status ?? ""] ?? [o.status ?? "", o.status ?? ""];
  const lv = new Map((o.recipient_address?.district_info ?? []).map((d) => [d.address_level ?? "", d.address_name ?? ""]));
  // 一个 line_item = 一件；按 SKU 汇总（与后台一行一个 SKU 一致）
  const skus = new Map<string, { li: LineItem; qty: number; orig: number; sale: number; sd: number; pd: number }>();
  for (const li of o.line_items ?? []) {
    const k = li.sku_id ?? "";
    const a = skus.get(k) ?? { li, qty: 0, orig: 0, sale: 0, sd: 0, pd: 0 };
    a.qty++; a.orig += cents(li.original_price); a.sale += cents(li.sale_price); a.sd += cents(li.seller_discount); a.pd += cents(li.platform_discount);
    skus.set(k, a);
  }
  // API 的 SKU 平台折扣含「支付平台优惠」，后台导出把它单列在 Payment platform discount。
  // 按 SKU 折后金额比例分摊、尾差给最后一个 SKU（PH 10-08 多 SKU 订单 5/5 与后台一致）。
  const list = [...skus.values()];
  const pay = cents(p.payment_platform_discount);
  const saleSum = list.reduce((s, a) => s + a.sale, 0);
  let left = pay;
  list.forEach((a, i) => {
    const share = i === list.length - 1 ? left : (saleSum ? Math.round(pay * a.sale / saleSum) : 0);
    left -= share;
    a.pd -= share;
  });
  const ret = en?.returns.get(o.id);
  const cancelType = o.status === "CANCELLED" ? "Cancel" : ret ? "Return/Refund" : "";
  return list.map((a) => {
    const r: Record<string, Cell> = {
      "Order ID": o.id, "Order Status": st, "Order Substatus": sub, "Cancelation/Return Type": cancelType,
      "Normal or Pre-order": a.li.sku_type === "PRE_ORDER" ? "Pre-order" : "Normal",
      "SKU ID": a.li.sku_id ?? "", "Seller SKU": a.li.seller_sku ?? "", "Product Name": a.li.product_name ?? "", "Variation": a.li.sku_name ?? "",
      "Quantity": a.qty, "Sku Quantity of return": en ? (ret?.get(a.li.sku_id ?? "")?.qty ?? 0) : null, "SKU Unit Original Price": money(Math.round(a.orig / a.qty)),
      "SKU Subtotal Before Discount": money(a.orig), "SKU Platform Discount": money(a.pd), "SKU Seller Discount": money(a.sd),
      "SKU Subtotal After Discount": money(a.sale),
      "Shipping Fee After Discount": num(p.shipping_fee), "Original Shipping Fee": num(p.original_shipping_fee),
      "Shipping Fee Seller Discount": num(p.shipping_fee_seller_discount), "Shipping Fee Platform Discount": num(p.shipping_fee_platform_discount),
      "Payment platform discount": money(pay), "Taxes": num(p.tax), "Order Amount": num(p.total_amount), "Order Refund Amount": en ? money(ret?.get(a.li.sku_id ?? "")?.refund ?? 0) : null,
      "Created Time": fmtTime(o.create_time, shop), "Paid Time": fmtTime(o.paid_time, shop), "RTS Time": fmtTime(o.rts_time, shop),
      "Shipped Time": fmtTime(o.collection_time, shop), "Delivered Time": fmtTime(o.delivery_time, shop), "Cancelled Time": fmtTime(o.cancel_time, shop),
      "Cancel By": CANCEL_BY[o.cancellation_initiator ?? ""] ?? (o.cancellation_initiator ?? ""), "Cancel Reason": o.cancel_reason ?? "",
      "Fulfillment Type": FULFILL[o.fulfillment_type ?? ""] ?? (o.fulfillment_type ?? ""), "Warehouse Name": en?.warehouses.get(o.warehouse_id ?? "") ?? "",
      "Tracking ID": o.tracking_number ?? "", "Delivery Option": o.delivery_option_name ?? "", "Shipping Provider Name": o.shipping_provider ?? "",
      "Buyer Message": o.buyer_message ?? "",
      // 买家个人信息（用户名/收件人/电话/详细地址）不导出
      "Buyer Username": "", "Recipient": "", "Phone #": "", "Zipcode": o.recipient_address?.postal_code ?? "",
      "Country": lv.get("L0") ?? "", "Region": lv.get("L1") ?? "", "Province": th ? (lv.get("L1") ?? "") : (lv.get("L2") ?? ""),
      "District": lv.get("L2") ?? "", "Municipality": lv.get("L3") ?? "", "Barangay": lv.get("L4") ?? "",
      "Detail Address": "", "Additional address information": "",
      "Payment Method": o.payment_method_name ?? "", "Weight(kg)": null, "Product Category": "", "Package ID": o.packages?.[0]?.id ?? "",
      "Seller Note": o.seller_note ?? "", "Checked Status": "", "Checked Marked by": "", "Order Channel": "", "Creator Handle": "",
    };
    return (th ? ORDER_COLUMNS_TH : ORDER_COLUMNS).map((c) => r[c] ?? null);
  });
}

async function exportOrders(shop: Shop, b: Record<string, unknown>, started: number): Promise<Chunk> {
  const win = monthWindow(shop, b.month);
  const th = (shop.region ?? "").toUpperCase() === "TH";
  const cur = (b.cursor ?? {}) as { page_token?: string; done?: number };
  let pageToken = cur.page_token ?? "", done = Number(cur.done ?? 0), total: number | null = null;
  const rows: Cell[][] = [];
  const errors: string[] = [];
  const warehouses = await warehouseNames(shop, errors);
  do {
    const r = await ttsCall<{ orders?: Order[]; next_page_token?: string; total_count?: number }>({
      method: "POST", path: "/order/202309/orders/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { page_size: 100, sort_field: "create_time", sort_order: "ASC", page_token: pageToken },
      body: { create_time_ge: win.from, create_time_lt: win.to },
    });
    if (r.code !== 0) { errors.push(apiErr("orders/search", r)); break; }
    total = r.data?.total_count ?? total;
    const orders = r.data?.orders ?? [];
    const returns = await returnsFor(shop, orders.map((o) => o.id), errors);
    for (const o of orders) { rows.push(...orderRows(o, shop, th, { warehouses, returns })); done++; }
    pageToken = r.data?.next_page_token ?? "";
  } while (pageToken && Date.now() - started < SOFT_MS);
  return {
    kind: "orders", columns: th ? ORDER_COLUMNS_TH : ORDER_COLUMNS, rows,
    // 仓库/退货补充失败不中断导出（记在 errors 里），只有订单列表本身失败才停
    next_cursor: pageToken && !errors.some((e) => e.startsWith("orders/search")) ? { page_token: pageToken, done } : null,
    progress: { done, total, unit: "单" }, errors,
  };
}

// ═══ 2. 财务结算（订单维度）══════════════════════════════════════════════════
// 后台「订单详情」页签的列名；SKU ID/数量/商品名称/SKU 名称 在订单维度下留空（API 按 SKU 拆需逐单调用，月度量级不可行）。
// 映射按字段含义对照，未全部核验；末尾附 API 原始分项（api.*），供核对与后续修正映射。
type Tx = Record<string, unknown> & {
  id?: string; type?: string; order_id?: string; adjustment_id?: string; adjustment_order_id?: string; associated_order_id?: string;
  settlement_amount?: string; revenue_amount?: string; shipping_cost_amount?: string; fee_tax_amount?: string; adjustment_amount?: string;
  revenue_breakdown?: Record<string, string>; shipping_cost_breakdown?: Record<string, unknown>;
  fee_tax_breakdown?: { fee?: Record<string, string>; tax?: Record<string, string> }; supplementary_component?: Record<string, string>;
};
const TX_TYPE: Record<string, string> = {
  ORDER: "订单", PLATFORM_REIMBURSEMENT: "平台赔付", LOGISTICS_REIMBURSEMENT: "物流赔付", SHIPPING_FEE_ADJUSTMENT: "运费调整",
  CHARGE_BACK: "拒付", DEDUCTIONS_INCURRED_BY_SELLER: "商家扣款",
};
// [后台列名, 取值路径]；路径以 r./s./f./t./x./sx. 开头分别对应 revenue/shipping/fee/tax/supplementary/shipping.supplementary
const FIN_MAP: Array<[string, string]> = [
  ["享受商家折扣后小计", "calc.after_seller_discount"], ["享受折扣前小计", "r.subtotal_before_discount_amount"], ["商家折扣", "r.seller_discount_amount"],
  ["享受商家折扣后的退款小计", "calc.refund_after_seller_discount"], ["享受商家折扣前的退款小计", "r.refund_subtotal_before_discount_amount"],
  ["商家折扣退款", "r.seller_discount_refund_amount"], ["总费用", "calc.total_fee"],
  ["交易手续费", "f.transaction_fee_amount"], ["TikTok Shop 佣金费", "f.platform_commission_amount"], ["商家运费", "top.shipping_cost_amount"],
  ["实际运费", "s.actual_shipping_fee_amount"], ["平台运费减免", "sx.platform_shipping_fee_discount_amount"],
  ["买家支付运费", "s.customer_paid_shipping_fee_amount"], ["实际退货运费", "s.return_shipping_fee_amount"],
  ["客户运费退款", "sx.refunded_customer_shipping_fee_amount"], ["运费补贴", "sx.shipping_fee_subsidy_amount"],
  ["Guarantee program reimbursement", "s.shipping_fee_guarantee_reimbursement"],
  ["联盟佣金", "f.affiliate_commission_amount"], ["联盟服务商佣金", "f.affiliate_partner_commission_amount"],
  ["联盟店铺广告佣金", "f.affiliate_ads_commission_amount"], ["联盟佣金保证金", "f.affiliate_commission_deposit"],
  ["联盟佣金退款", "f.affiliate_commission_release"], ["联盟服务商店铺广告佣金", "f.tap_shop_ads_commission"],
  ["SFP 服务费", "f.sfp_service_fee_amount"], ["奖金返现服务费", "f.bonus_cashback_service_fee_amount"],
  ["直播特别活动服务费", "f.live_specials_fee_amount"], ["超级优惠券服务费", "f.voucher_xtra_service_fee_amount"],
  ["EAMS 计划服务费", "f.external_affiliate_marketing_fee_amount"], ["秒杀服务费", "f.flash_sales_service_fee_amount"],
  ["TikTok PayLater 计划费用", "f.seller_paylater_handling_fee_amount"], ["物流服务费", "s.logistics_service_fee"],
  ["活动资源费", "f.campaign_resource_fee"], ["订单处理手续费", "f.fee_per_item_sold_amount"], ["GMV Max 优惠券", "f.gmv_max_coupon_fee"],
  ["SFR service fee", "f.refund_administration_fee_amount"], ["托管服务计划（销售税）", "f.platform_semi_managed_commission_fee_tax"],
  ["托管服务计划（每单费用）", "f.platform_semi_managed_commission_fee"], ["商家成长服务费", "f.seller_growth_fee_amount"],
  ["GMV Max 广告费", "f.gmv_max_ad_fee_amount"], ["Guarantee program fee", "f.shipping_fee_guarantee_service_fee"],
  ["调整金额", "top.adjustment_amount"],
];
const FIN_TAIL: Array<[string, string]> = [
  ["客户付款", "x.customer_payment_amount"], ["客户退款", "x.customer_refund_amount"],
  ["商家共同赞助优惠券折扣", "x.seller_cofunded_discount_amount"], ["商家共同赞助优惠券折扣退款", "x.seller_cofunded_discount_refund_amount"],
  ["平台折扣", "x.platform_discount_amount"], ["平台折扣退款", "x.platform_discount_refund_amount"],
  ["平台共同赞助优惠券折扣", "x.platform_cofunded_discount_amount"], ["平台共同赞助优惠券折扣退款", "x.platform_cofunded_discount_refund_amount"],
  ["商家运费折扣", "sx.seller_shipping_fee_discount_amount"],
];
const FIN_HEAD = ["结算日期", "结算单 ID", "货币", "交易类型", "订单ID/调整单ID", "SKU ID", "数量", "商品名称", "SKU 名称", "结算总金额", "总收入"];
const API_GROUPS: Array<[string, (t: Tx) => Record<string, unknown> | undefined]> = [
  ["r", (t) => t.revenue_breakdown], ["s", (t) => t.shipping_cost_breakdown as Record<string, unknown> | undefined],
  ["sx", (t) => (t.shipping_cost_breakdown?.supplementary_component as Record<string, unknown> | undefined)],
  ["f", (t) => t.fee_tax_breakdown?.fee], ["t", (t) => t.fee_tax_breakdown?.tax], ["x", (t) => t.supplementary_component],
];

function txGet(t: Tx, path: string): Cell {
  const [g, k] = path.split(".");
  if (g === "top") return num(t[k]);
  if (g === "calc") {
    const r = t.revenue_breakdown ?? {};
    if (k === "after_seller_discount") return money(cents(r.subtotal_before_discount_amount) - Math.abs(cents(r.seller_discount_amount)));
    // 退款为负数：退款后小计 = 退款前小计（负）+ |商家折扣退款|。符号约定待用后台导出核对
    if (k === "refund_after_seller_discount") return money(cents(r.refund_subtotal_before_discount_amount) + Math.abs(cents(r.seller_discount_refund_amount)));
    if (k === "total_fee") return money(cents(t.fee_tax_amount) + cents(t.shipping_cost_amount));
  }
  const src = API_GROUPS.find(([n]) => n === g)?.[1](t);
  const v = src?.[k];
  return typeof v === "object" ? null : num(v);
}

function finRow(t: Tx, stmt: { id: string; time: number; currency: string }, shop: Shop, apiKeys: string[]): Cell[] {
  const isOrder = (t.type ?? "ORDER") === "ORDER";
  const head: Cell[] = [
    fmtDate(stmt.time, shop), stmt.id, stmt.currency, TX_TYPE[t.type ?? ""] ?? (t.type ?? ""),
    isOrder ? (t.order_id ?? "") : (t.adjustment_id ?? t.id ?? ""), "", null, "", "", num(t.settlement_amount), num(t.revenue_amount),
  ];
  const mid = FIN_MAP.map(([, p]) => txGet(t, p));
  const rel = isOrder ? "" : (t.adjustment_order_id ?? t.associated_order_id ?? t.order_id ?? "");
  const tail = FIN_TAIL.map(([, p]) => txGet(t, p));
  const raw = apiKeys.map((k) => txGet(t, k));
  return [...head, ...mid, rel, ...tail, t.type ?? "", t.id ?? "", ...raw];
}

/** API 原始分项列（固定顺序，取文档里列出的全部数值字段） */
const API_KEYS: string[] = [
  ...["subtotal_before_discount_amount", "refund_subtotal_before_discount_amount", "seller_discount_amount", "seller_discount_refund_amount",
    "cod_service_fee_amount", "refund_cod_service_fee_amount", "distant_item_fee_amount"].map((k) => `r.${k}`),
  ...["actual_shipping_fee_amount", "international_leg_logistics_amount", "shipping_fee_discount_amount", "customer_paid_shipping_fee_amount",
    "return_shipping_fee_amount", "replacement_shipping_fee_amount", "exchange_shipping_fee_amount", "signature_confirmation_fee_amount",
    "shipping_insurance_fee_amount", "fbt_fulfillment_fee_reimbursement_amount", "return_shipping_label_fee_amount",
    "seller_self_shipping_service_fee_amount", "return_shipping_fee_paid_buyer_amount", "failed_delivery_subsidy_amount",
    "shipping_fee_guarantee_reimbursement", "fbt_free_shipping_fee_amount", "free_return_subsidy_amount", "distant_shipping_fee_amount",
    "shipping_app_service_fee_amount", "logistics_service_fee", "tiktok_shop_shipping_incentive_amount"].map((k) => `s.${k}`),
  ...["platform_shipping_fee_discount_amount", "promo_shipping_incentive_amount", "shipping_fee_subsidy_amount", "seller_shipping_fee_discount_amount",
    "customer_shipping_fee_offset_amount", "fbm_shipping_cost_amount", "fbt_shipping_cost_amount", "return_refund_subsidy_amount",
    "refunded_customer_shipping_fee_amount", "customer_shipping_fee", "refund_customer_shipping_fee"].map((k) => `sx.${k}`),
  ...["platform_commission_amount", "referral_fee_amount", "refund_administration_fee_amount", "transaction_fee_amount",
    "credit_card_handling_fee_amount", "affiliate_commission_amount", "affiliate_commission_amount_before_pit", "affiliate_partner_commission_amount",
    "affiliate_ads_commission_amount", "sfp_service_fee_amount", "live_specials_fee_amount", "bonus_cashback_service_fee_amount",
    "mall_service_fee_amount", "voucher_xtra_service_fee_amount", "flash_sales_service_fee_amount", "cofunded_promotion_service_fee_amount",
    "pre_order_service_fee_amount", "tsp_commission_amount", "dt_handling_fee_amount", "epr_pob_service_fee_amount",
    "seller_paylater_handling_fee_amount", "fee_per_item_sold_amount", "cofunded_creator_bonus_amount", "dynamic_commission_amount",
    "external_affiliate_marketing_fee_amount", "affiliate_commission_deposit", "affiliate_commission_release", "tap_shop_ads_commission",
    "shipping_fee_guarantee_service_fee", "campaign_resource_fee", "platform_special_service_fee_amount", "smart_promotion_fee_amount",
    "gmv_max_ad_fee_amount", "platform_semi_managed_commission_fee", "platform_semi_managed_commission_fee_tax", "seller_growth_fee_amount",
    "gmv_max_coupon_fee", "new_customer_growth_package_fee", "target_product_gmv_growth_package_fee", "store_gmv_growth_package_fee",
    "auto_post_shoppable_video_commission_fee"].map((k) => `f.${k}`),
  ...["vat_amount", "import_vat_amount", "customs_duty_amount", "sst_amount", "gst_amount", "local_vat_amount", "pit_amount"].map((k) => `t.${k}`),
  ...["customer_payment_amount", "customer_refund_amount", "platform_discount_amount", "platform_discount_refund_amount",
    "seller_cofunded_discount_amount", "seller_cofunded_discount_refund_amount", "platform_cofunded_discount_amount",
    "platform_cofunded_discount_refund_amount"].map((k) => `x.${k}`),
  "top.shipping_cost_amount", "top.fee_tax_amount", "top.adjustment_amount",
];
export const FIN_COLUMNS = [
  ...FIN_HEAD, ...FIN_MAP.map(([c]) => c), "相关订单 ID", ...FIN_TAIL.map(([c]) => c), "API交易类型", "API交易ID", ...API_KEYS.map((k) => `api.${k}`),
];

type Stmt = {
  id: string; statement_time?: number; create_time?: number; currency?: string; settlement_amount?: string; revenue_amount?: string;
  fee_amount?: string; adjustment_amount?: string; shipping_cost_amount?: string; payment_id?: string; payment_status?: string;
};
type FinCursor = { stmts: Array<{ id: string; time: number; currency: string }>; idx: number; page_token: string; done: number };

async function exportFinance(shop: Shop, b: Record<string, unknown>, started: number): Promise<Chunk> {
  const win = monthWindow(shop, b.month);
  const errors: string[] = [];
  let cur = b.cursor as FinCursor | undefined;
  let statements: Cell[][] | undefined;
  if (!cur) {
    // 首片：列出本月全部结算单（= 后台「对账单」页签）
    const list: Stmt[] = [];
    let tok = "";
    do {
      const r = await ttsCall<{ statements?: Stmt[]; next_page_token?: string }>({
        method: "GET", path: "/finance/202309/statements", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
        query: { statement_time_ge: win.from, statement_time_lt: win.to, page_size: 100, sort_field: "statement_time", sort_order: "ASC", page_token: tok },
      });
      if (r.code !== 0) { errors.push(apiErr("statements", r)); break; }
      list.push(...(r.data?.statements ?? []));
      tok = r.data?.next_page_token ?? "";
    } while (tok);
    statements = list.map((s) => [
      fmtDate(s.statement_time ?? s.create_time, shop), s.id, num(s.settlement_amount), num(s.revenue_amount), num(s.fee_amount),
      num(s.adjustment_amount), num(s.shipping_cost_amount), s.payment_id ?? "", s.payment_status ?? "", s.currency ?? "",
    ]);
    cur = { stmts: list.map((s) => ({ id: s.id, time: Number(s.statement_time ?? s.create_time ?? 0), currency: s.currency ?? "" })), idx: 0, page_token: "", done: 0 };
  }
  const rows: Cell[][] = [];
  while (cur.idx < cur.stmts.length && Date.now() - started < SOFT_MS && !errors.length) {
    const st = cur.stmts[cur.idx];
    const r = await ttsCall<{ transactions?: Tx[]; next_page_token?: string }>({
      method: "GET", path: `/finance/202501/statements/${st.id}/statement_transactions`, accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { page_size: 100, sort_field: "order_create_time", sort_order: "ASC", page_token: cur.page_token },
    });
    if (r.code !== 0) { errors.push(apiErr(`statement_transactions ${st.id}`, r)); break; }
    for (const t of r.data?.transactions ?? []) rows.push(finRow(t, st, shop, API_KEYS));
    cur.page_token = r.data?.next_page_token ?? "";
    if (!cur.page_token) { cur.idx++; cur.done++; }
  }
  const more = cur.idx < cur.stmts.length && !errors.length;
  return {
    kind: "finance", columns: FIN_COLUMNS, rows, next_cursor: more ? { ...cur } : null,
    progress: { done: cur.done, total: cur.stmts.length, unit: "张结算单" },
    meta: statements
      ? { statement_columns: ["结算日期", "结算单 ID", "结算总金额", "总收入", "总费用", "调整", "运费", "付款 ID", "付款状态", "货币"], statements }
      : undefined,
    errors,
  };
}

// ═══ 3. 商品 + 活动价 ═══════════════════════════════════════════════════════
const PRODUCT_FIXED: Array<[string, string]> = [
  ["product_id", "商品 ID"], ["category", "类目"], ["product_name", "商品名称"], ["product_status", "商品状态"], ["sku_id", "SKU ID"],
  ["variation_value", "变体选项"], ["product_description", "商品描述"], ["brand", "品牌"], ["price", "零售价（本地币种）"],
  ["pre_order_time", "预售: 处理时长"], ["seller_sku", "商家 SKU"], ["parcel_weight", "包裹重量(g)"], ["parcel_length", "包裹长度(cm)"],
  ["parcel_width", "包裹宽度(cm)"], ["parcel_height", "包裹高度(cm)"], ["cod", "您可以选择商品是否支持货到付款"], ["main_image", "主图"],
  ["image_2", "图片 2"], ["image_3", "图片 3"], ["image_4", "图片 4"], ["image_5", "图片 5"], ["image_6", "图片 6"], ["image_7", "图片 7"],
  ["image_8", "商品图片 8"], ["image_9", "商品图片 9"], ["size_chart", "尺码表"], ["special_product_listing_type", "销售形式"],
  ["auction_starting_price", "起拍价"],
];
const PRODUCT_STATUS: Record<string, string> = { ACTIVATE: "在售(1)", SELLER_DEACTIVATED: "已下架", PLATFORM_DEACTIVATED: "平台下架", DRAFT: "草稿", PENDING: "审核中", FAILED: "审核失败", FREEZE: "冻结", DELETED: "已删除" };
type Img = { urls?: string[] };
type ProductDetail = {
  id: string; title?: string; status?: string; description?: string; is_cod_allowed?: boolean; selling_format?: string;
  brand?: { id?: string; name?: string }; category_chains?: Array<{ id?: string; local_name?: string; is_leaf?: boolean }>;
  main_images?: Img[]; size_chart?: { image?: Img; template?: { id?: string } };
  package_weight?: { unit?: string; value?: string }; package_dimensions?: { unit?: string; length?: string; width?: string; height?: string };
  product_attributes?: Array<{ id?: string; name?: string; values?: Array<{ name?: string }> }>;
  skus?: Array<{
    id?: string; seller_sku?: string; price?: { sale_price?: string; starting_bid_price?: string };
    sales_attributes?: Array<{ value_name?: string }>;
    pre_sale?: { fulfillment_type?: { handling_duration_days?: number } };
  }>;
};
type ProdCursor = { phase: "list" | "detail"; page_token: string; ids: string[]; idx: number; prices?: Record<string, string> };

function grams(w?: { unit?: string; value?: string }): Cell {
  if (!w?.value) return null;
  const v = Number(w.value);
  return w.unit === "GRAM" ? v : w.unit === "POUND" ? Math.round(v * 453.592) : Math.round(v * 1000 * 100) / 100;
}

async function activityPrices(shop: Shop, activityId: string, errors: string[]) {
  const prices: Record<string, string> = {};
  let title = "";
  if (!activityId) return { prices, title };
  const r = await ttsCall<{ title?: string; product_level?: string; products?: Array<{ id?: string; activity_price?: { amount?: string }; skus?: Array<{ id?: string; activity_price?: { amount?: string } }> }> }>({
    method: "GET", path: `/promotion/202309/activities/${activityId}`, accessToken: shop.access_token, shopCipher: shop.shop_cipher,
  });
  if (r.code !== 0) { errors.push(apiErr(`活动 ${activityId}`, r)); return { prices, title }; }
  title = r.data?.title ?? "";
  for (const p of r.data?.products ?? []) {
    // VARIATION 级活动价在 sku 上；PRODUCT 级在商品上（key 用 p:<product_id>）
    for (const s of p.skus ?? []) if (s.id && s.activity_price?.amount) prices[s.id] = s.activity_price.amount;
    if (p.id && p.activity_price?.amount) prices[`p:${p.id}`] = p.activity_price.amount;
  }
  return { prices, title };
}

async function exportProducts(shop: Shop, b: Record<string, unknown>, started: number): Promise<Chunk> {
  const errors: string[] = [];
  const activityId = String(b.activity_id ?? "").trim();
  if (activityId && !/^\d+$/.test(activityId)) bad("activity_id 只能是数字");
  const status = String(b.status ?? "ACTIVATE");
  let cur = b.cursor as ProdCursor | undefined;
  let meta: Record<string, unknown> | undefined;
  if (!cur) {
    const ap = await activityPrices(shop, activityId, errors);
    cur = { phase: "list", page_token: "", ids: [], idx: 0, prices: ap.prices };
    meta = { activity_id: activityId, activity_title: ap.title, activity_sku_count: Object.keys(ap.prices).length };
  }
  // 阶段一：列出全部商品 ID
  let fatal = errors.length > 0;
  while (cur.phase === "list" && Date.now() - started < SOFT_MS && !fatal) {
    const r = await ttsCall<{ products?: Array<{ id: string }>; next_page_token?: string }>({
      method: "POST", path: "/product/202502/products/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { page_size: 100, page_token: cur.page_token }, body: status === "ALL" ? {} : { status },
    });
    if (r.code !== 0) { errors.push(apiErr("products/search", r)); fatal = true; break; }
    cur.ids.push(...(r.data?.products ?? []).map((p) => p.id));
    cur.page_token = r.data?.next_page_token ?? "";
    if (!cur.page_token) cur.phase = "detail";
  }
  // 阶段二：逐个取商品详情，展开成 SKU 行
  const rows: Cell[][] = [];
  const attrs: Record<string, string> = {};
  const prices = cur.prices ?? {};
  while (cur.phase === "detail" && cur.idx < cur.ids.length && Date.now() - started < SOFT_MS && !fatal) {
    const pid = cur.ids[cur.idx];
    const r = await ttsCall<ProductDetail>({
      method: "GET", path: `/product/202309/products/${pid}`, accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { locale: "zh-CN" },
    });
    cur.idx++;
    if (r.code !== 0 || !r.data) { errors.push(apiErr(`product ${pid}`, r)); continue; } // 单个商品失败不中断，记入 errors
    const p = r.data;
    const leaf = (p.category_chains ?? []).find((c) => c.is_leaf) ?? p.category_chains?.at(-1);
    const imgs = (p.main_images ?? []).map((i) => i.urls?.[0] ?? "");
    const dim = p.package_dimensions;
    const attrMap: Record<string, string> = {};
    for (const a of p.product_attributes ?? []) {
      if (!a.id) continue;
      attrs[a.id] = a.name ?? a.id;
      attrMap[`product_property/${a.id}`] = (a.values ?? []).map((v) => v.name ?? "").filter(Boolean).join(",");
    }
    for (const s of p.skus ?? []) {
      const act = (s.id && prices[s.id]) ?? prices[`p:${p.id}`] ?? null;
      const fixed: Record<string, Cell> = {
        product_id: p.id, category: leaf ? `${leaf.local_name ?? ""} (${leaf.id ?? ""})` : "", product_name: p.title ?? "",
        product_status: PRODUCT_STATUS[p.status ?? ""] ?? (p.status ?? ""), sku_id: s.id ?? "",
        variation_value: (s.sales_attributes ?? []).map((a) => a.value_name ?? "").join(", "), product_description: p.description ?? "",
        brand: p.brand?.name ? `${p.brand.name} (${p.brand.id ?? ""})` : "", price: num(s.price?.sale_price),
        pre_order_time: s.pre_sale?.fulfillment_type?.handling_duration_days ?? null, seller_sku: s.seller_sku ?? "",
        parcel_weight: grams(p.package_weight), parcel_length: num(dim?.length), parcel_width: num(dim?.width), parcel_height: num(dim?.height),
        cod: p.is_cod_allowed === undefined ? "" : p.is_cod_allowed ? "Y" : "N",
        main_image: imgs[0] ?? "", image_2: imgs[1] ?? "", image_3: imgs[2] ?? "", image_4: imgs[3] ?? "", image_5: imgs[4] ?? "",
        image_6: imgs[5] ?? "", image_7: imgs[6] ?? "", image_8: imgs[7] ?? "", image_9: imgs[8] ?? "",
        size_chart: p.size_chart?.template?.id ?? p.size_chart?.image?.urls?.[0] ?? "",
        special_product_listing_type: p.selling_format === "AUCTION" ? "Live auction" : "Fixed price",
        auction_starting_price: num(s.price?.starting_bid_price),
      };
      // 行 = 固定列 + {属性列: 值} + 活动价；属性列在前端汇总全部商品后统一排列
      rows.push([...PRODUCT_FIXED.map(([k]) => fixed[k] ?? null), JSON.stringify(attrMap), num(act)]);
    }
  }
  const more = !fatal && (cur.phase === "list" || cur.idx < cur.ids.length);
  return {
    kind: "products",
    columns: [...PRODUCT_FIXED.map(([k]) => k), "__attrs", "活动价"],
    rows, next_cursor: more ? { ...cur } : null,
    progress: { done: cur.idx, total: cur.phase === "detail" ? cur.ids.length : null, unit: "个商品" },
    meta: { ...(meta ?? {}), fixed_labels: PRODUCT_FIXED.map(([, l]) => l), attr_names: attrs },
    errors,
  };
}

// ═══ 4. 联盟订单 ═══════════════════════════════════════════════════════════
const AFF_STATUS: Record<string, string> = { AWAITINGPAYMENT: "客户未付款", TOSETTLE: "待确认", SETTLED: "已结算", INELIGIBLE: "不符合条件", UNKNOWN: "未知" };
const CONTENT: Record<string, string> = { VIDEO: "视频", LIVE: "直播", SHOP: "商品橱窗", PRE_LIVE: "直播预告", PROMOTION_PAGE: "外部流量计划", LINKSHARE: "外部流量计划" };
export const AFF_CREATOR_COLUMNS = [
  "订单 ID", "商品 ID", "商品名称 ", "SKU ID", "商品价格", "支付金额", "货币单位", "下单件数", "已全部退货或全额退款", "付款方式", "订单状态",
  "达人用户名", "内容形式", "轮播", "内容ID", "commission model", "PIT 预扣税率", "预计 PIT", "实际 PIT", "标准佣金率", "预估计佣金额",
  "预计标准佣金付款", "实际计佣金额", "实际佣金", "店铺广告佣金率", "预计店铺广告佣金付款", "实际店铺广告佣金付款", "预估合资达人奖金",
  "实际合资达人奖金", "创建时间", "支付时间", "订单送达时间", "佣金结算时间", "平台",
];
export const AFF_PARTNER_COLUMNS = [
  "订单 ID", "商品 ID", "商品名称 ", "Sku Id", "商品价格", "支付金额", "货币单位", "下单件数", "已全部退货或全额退款", "付款方式", "订单状态",
  "预估计佣金额", "实际计佣金额", "佣金率 (%)", "预估佣金", "实际佣金", "店铺广告佣金率", "预计店铺广告佣金付款", "实际店铺广告佣金付款",
  "联盟团长活动 ID", "联盟团长ID", "联盟团长名称", "联盟团长佣金率", "预估联盟团长佣金", "实际联盟团长佣金", "创建时间", "支付时间",
  "订单送达时间", "佣金结算时间", "平台", "轮播",
];
type AffSku = Record<string, unknown> & {
  sku_id?: string; product_id?: string; settlement_status?: string; campaign_id?: string; creator_username?: string; quantity?: number;
  content_type?: string; content_id?: string; commission_model?: string; commission_rate?: number | string; partner_commission_rate?: number | string;
  shop_ads_commission_rate?: number | string; fully_return?: string; is_carousel?: boolean | string; sku_name?: string;
  price?: { amount?: string; currency?: string };
};
type AffOrder = { id: string; create_time?: number; delivery_time?: number; skus?: AffSku[] };
type OrderInfo = { paid_time?: number; is_cod?: boolean; names: Record<string, string>; pay: Record<string, number> };

/** 用订单详情补 商品名称 / 付款方式 / 支付时间 / 支付金额（联盟订单接口不返回这些字段） */
async function orderInfo(shop: Shop, ids: string[], errors: string[]): Promise<Map<string, OrderInfo>> {
  const out = new Map<string, OrderInfo>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ttsCall<{ orders?: Order[] & Array<{ is_cod?: boolean }> }>({
      method: "GET", path: "/order/202309/orders", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { ids: ids.slice(i, i + 50).join(",") },
    });
    if (r.code !== 0) { errors.push(apiErr("orders detail", r)); continue; }
    for (const o of (r.data?.orders ?? []) as Array<Order & { is_cod?: boolean }>) {
      const names: Record<string, string> = {}, pay: Record<string, number> = {};
      for (const li of o.line_items ?? []) {
        if (li.sku_id) { names[li.sku_id] = li.product_name ?? ""; pay[li.sku_id] = (pay[li.sku_id] ?? 0) + cents(li.sale_price); }
      }
      out.set(o.id, { paid_time: o.paid_time, is_cod: o.is_cod, names, pay });
    }
  }
  return out;
}

async function exportAffiliate(shop: Shop, b: Record<string, unknown>, started: number): Promise<Chunk> {
  const win = monthWindow(shop, b.month);
  const cur = (b.cursor ?? {}) as { page_token?: string; done?: number };
  let pageToken = cur.page_token ?? "", done = Number(cur.done ?? 0), total: number | null = null;
  const errors: string[] = [];
  const rows: Cell[][] = [];
  do {
    const r = await ttsCall<{ orders?: AffOrder[]; next_page_token?: string; total_count?: number }>({
      method: "POST", path: "/affiliate_seller/202410/orders/search", accessToken: shop.access_token, shopCipher: shop.shop_cipher,
      query: { page_size: 100, page_token: pageToken }, body: { create_time_ge: win.from, create_time_lt: win.to },
    });
    if (r.code !== 0) { errors.push(apiErr("affiliate orders/search", r)); break; }
    total = r.data?.total_count ?? total;
    const orders = r.data?.orders ?? [];
    const info = await orderInfo(shop, orders.map((o) => o.id), errors);
    for (const o of orders) {
      done++;
      const oi = info.get(o.id);
      for (const s of o.skus ?? []) {
        const partner = Boolean(s.campaign_id) || Number(s.partner_commission_rate ?? 0) > 0;
        const st = AFF_STATUS[String(s.settlement_status ?? "").toUpperCase().replace(/[^A-Z]/g, "")] ?? (s.settlement_status ?? "");
        const payAmt = oi?.pay[s.sku_id ?? ""];
        const v: Record<string, Cell> = {
          "订单 ID": o.id, "商品 ID": s.product_id ?? "", "商品名称 ": oi?.names[s.sku_id ?? ""] ?? "", "SKU ID": s.sku_id ?? "", "Sku Id": s.sku_id ?? "",
          "商品价格": num(s.price?.amount), "支付金额": payAmt === undefined ? null : money(payAmt), "货币单位": s.price?.currency ?? "",
          "下单件数": num(s.quantity), "已全部退货或全额退款": /^y/i.test(String(s.fully_return ?? "")) ? "是" : "否",
          "付款方式": oi?.is_cod === undefined ? "" : oi.is_cod ? "货到付款" : "非货到付款", "订单状态": st,
          "达人用户名": s.creator_username ?? "", "内容形式": CONTENT[String(s.content_type ?? "")] ?? (s.content_type ?? ""),
          "轮播": String(s.is_carousel ?? "").toLowerCase() === "true" ? "是" : "", "内容ID": s.content_id ?? "",
          "commission model": String(s.commission_model ?? "").toLowerCase(),
          "PIT 预扣税率": null, "预计 PIT": null, "实际 PIT": null,
          "标准佣金率": pct(s.commission_rate), "佣金率 (%)": pct(s.commission_rate),
          "预估计佣金额": amt(s.estimated_commission_base), "预计标准佣金付款": amt(s.estimated_paid_commission), "预估佣金": amt(s.estimated_paid_commission),
          "实际计佣金额": amt(s.actual_commission_base), "实际佣金": amt(s.actual_paid_commission),
          "店铺广告佣金率": pct(s.shop_ads_commission_rate), "预计店铺广告佣金付款": amt(s.estimated_paid_shop_ads_commission),
          "实际店铺广告佣金付款": amt(s.actual_paid_shop_ads_commission),
          "预估合资达人奖金": amt(s.estimated_cofunded_creator_bonus_amount), "实际合资达人奖金": amt(s.actual_cofunded_creator_bonus_amount),
          "联盟团长活动 ID": s.campaign_id ?? "", "联盟团长ID": "", "联盟团长名称": "", "联盟团长佣金率": pct(s.partner_commission_rate),
          "预估联盟团长佣金": amt(s.estimated_paid_partner_commission), "实际联盟团长佣金": amt(s.actual_paid_partner_commission),
          "创建时间": fmtTime(o.create_time, shop), "支付时间": fmtTime(oi?.paid_time, shop), "订单送达时间": fmtTime(o.delivery_time, shop),
          "佣金结算时间": "", "平台": "",
        };
        const cols = partner ? AFF_PARTNER_COLUMNS : AFF_CREATOR_COLUMNS;
        rows.push([partner ? "partner" : "creator", ...cols.map((c) => v[c] ?? null)]);
      }
    }
    pageToken = r.data?.next_page_token ?? "";
  } while (pageToken && Date.now() - started < SOFT_MS && !errors.some((e) => e.startsWith("affiliate")));
  const fatal = errors.some((e) => e.startsWith("affiliate"));
  return {
    kind: "affiliate", columns: ["__group", "...按 group 取 meta.creator_columns / meta.partner_columns"], rows,
    next_cursor: pageToken && !fatal ? { page_token: pageToken, done } : null,
    progress: { done, total, unit: "单" },
    meta: { creator_columns: AFF_CREATOR_COLUMNS, partner_columns: AFF_PARTNER_COLUMNS },
    errors,
  };
}

// ═══ 5. 申样审核数据（只读，不调审样接口）══════════════════════════════════
// 只返回原始数据，审核意见由前端按负责人勾选的条件计算（src/lib/sampleAdvice.ts）。
// - 历史发样：读飞书建联表的每晚缓存 connection_material_registry（与「发样及素材统计」同源），不再逐个调 TikTok 接口
// - 商家 SKU：sku_product_map（飞书「SKU匹配表-TK」每晚同步）
// - GMV 折美元：gmv_exchange_rates（设置 → 汇率设置）
type SampleApp = {
  id?: string; status?: string; commission_rate?: string | number; is_approvable?: boolean; disapprovable_reasons?: string[];
  fulfillment_status?: string; order_id?: string; tracking_number?: string; partner_name?: string; approve_expiration_time?: number;
  creator?: { creator_open_id?: string; username?: string; nickname?: string; follower_count?: number; avatar_url?: string; gmv?: { amount?: string; currency?: string };
    content_count?: number; fulfillment_percentage?: string | number; ec_video_view?: number };
  product?: { id?: string; title?: string; sku_id?: string; sku_name?: string };
};
export const SAMPLE_COLUMNS = [
  "申样单 ID", "申请状态", "达人用户名", "达人昵称", "TikTok用户ID", "creator_open_id", "头像", "粉丝数", "达人GMV(本币)", "GMV币种", "达人GMV(USD)",
  "达人销量(件)", "带货内容数", "平台履约率(%)", "带货率(post_rate)", "电商视频平均播放", "近30天发视频数(中位)",
  "建联表发样次数", "建联表有VID次数", "建联表未出素材次数", "最近发样日", "建联同事",
  "商品 ID", "商品名称", "SKU ID", "SKU 名称", "商家SKU", "申请佣金率", "平台可审批", "不可审批原因", "服务商", "审核截止时间",
];
type Perf = { units_sold?: number; post_rate?: number | string; avg_ec_video_play_count?: number; profile_tt_uri?: string; creator_profile?: { video_publish_cnt_30d_med?: number } };
const REGION_CURRENCY: Record<string, string> = { PH: "PHP", TH: "THB", VN: "VND", MY: "MYR", SG: "SGD", MX: "MXN", JP: "JPY", US: "USD", ID: "IDR", BR: "BRL" };
/** 发样超过多少天仍没有 VID 才算「未出素材」（刚发的样还在拍） */
const UNFULFILLED_AFTER_DAYS = 14;

async function usdRates(): Promise<Map<string, number>> {
  const { data, error } = await admin().from("gmv_exchange_rates").select("currency,usd_rate,enabled");
  if (error) throw error;
  return new Map((data ?? []).filter((r: { enabled: boolean }) => r.enabled).map((r: { currency: string; usd_rate: number }) => [r.currency.toUpperCase(), Number(r.usd_rate)]));
}

async function exportSamples(shop: Shop, b: Record<string, unknown>, started: number): Promise<Chunk> {
  const status = String(b.status ?? "PENDING");
  const cur = (b.cursor ?? {}) as { page_token?: string; done?: number };
  let pageToken = cur.page_token ?? "", done = Number(cur.done ?? 0), total: number | null = null;
  const rows: Cell[][] = [];
  const errors: string[] = [];
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const region = (shop.region ?? "").toUpperCase();
  const pool = region.startsWith("PH") ? ["PH", "PH2", "PHL"] : [region];
  const rates = await usdRates();
  const cutoff = new Date(Date.now() - UNFULFILLED_AFTER_DAYS * 86400_000).toISOString().slice(0, 10);
  do {
    const r = await ttsCall<{ sample_applications?: SampleApp[]; next_page_token?: string; total_count?: number }>({
      ...T, method: "POST", path: "/affiliate_seller/202508/sample_applications/search",
      query: { page_size: 50, page_token: pageToken }, body: status === "ALL" ? {} : { status },
    });
    if (r.code !== 0) { errors.push(apiErr("sample_applications/search", r)); break; }
    total = r.data?.total_count ?? total;
    const apps = r.data?.sample_applications ?? [];
    const handles = [...new Set(apps.map((a) => normHandle(a.creator?.username ?? "")).filter(Boolean))];
    const skuIds = [...new Set(apps.map((a) => a.product?.sku_id ?? "").filter(Boolean))];
    // 建联表历史（同站点池）：handle 大小写/@ 不敏感
    const hist = new Map<string, { n: number; vid: number; open: number; last: string; staff: Set<string> }>();
    if (handles.length) {
      const { data, error } = await admin().from("connection_material_registry")
        .select("handle,country,sample_date,vid,staff_name,source_type").eq("source_type", "BD").in("country", pool)
        // 大小写不敏感精确匹配（ilike 不带通配符），兼容表里带 @ 的写法
        .or(handles.flatMap((h) => [`handle.ilike."${h}"`, `handle.ilike."@${h}"`]).join(","))
        .limit(10000);
      if (error) errors.push(`建联表缓存：${error.message}`);
      const want = new Set(handles);
      for (const x of (data ?? []) as Array<{ handle: string; sample_date: string | null; vid: string; staff_name: string }>) {
        const h = normHandle(x.handle);
        if (!want.has(h) || !x.sample_date) continue;
        const a = hist.get(h) ?? { n: 0, vid: 0, open: 0, last: "", staff: new Set<string>() };
        a.n++;
        if (x.vid) a.vid++; else if (x.sample_date <= cutoff) a.open++;
        if (x.sample_date > a.last) a.last = x.sample_date;
        a.staff.add(x.staff_name);
        hist.set(h, a);
      }
    }
    const skuMap = new Map<string, string>();
    if (skuIds.length) {
      const { data, error } = await admin().from("sku_product_map").select("sku_id,merchant_sku").in("sku_id", skuIds);
      if (error) errors.push(`SKU 映射：${error.message}`);
      for (const x of (data ?? []) as Array<{ sku_id: string; merchant_sku: string }>) if (x.merchant_sku) skuMap.set(x.sku_id, x.merchant_sku);
    }
    const perf = new Map<string, Perf>();
    for (const oid of [...new Set(apps.map((a) => a.creator?.creator_open_id ?? "").filter(Boolean))]) {
      // 达人广场表现（销量、带货率、播放、TikTok 主页 URI）；统计窗口以接口口径为准，未核验
      const pr = await ttsCall<{ creator?: Perf }>({ ...T, method: "GET", path: `/affiliate_seller/202608/marketplace_creators/${oid}` });
      if (pr.code === 0 && pr.data?.creator) perf.set(oid, pr.data.creator);
      else errors.push(apiErr(`达人表现 ${oid}`, pr));
    }
    for (const a of apps) {
      done++;
      const c = a.creator ?? {};
      const pf = perf.get(c.creator_open_id ?? "");
      const h = hist.get(normHandle(c.username ?? ""));
      const gmv = c.gmv?.amount === undefined || c.gmv?.amount === "" ? null : Number(c.gmv.amount);
      const cur = (c.gmv?.currency || REGION_CURRENCY[region] || "").toUpperCase();
      const rate = cur === "USD" ? 1 : rates.get(cur);
      const ttUid = (pf?.profile_tt_uri ?? "").match(/profile\/(\d+)/)?.[1] ?? "";
      rows.push([
        a.id ?? "", a.status ?? "", c.username ?? "", c.nickname ?? "", ttUid, c.creator_open_id ?? "", c.avatar_url ?? "",
        num(c.follower_count), gmv, cur, gmv !== null && rate ? Math.round((gmv / rate) * 100) / 100 : null,
        num(pf?.units_sold), num(c.content_count),
        c.fulfillment_percentage === undefined || c.fulfillment_percentage === "" ? null : Number(c.fulfillment_percentage),
        num(pf?.post_rate), num(pf?.avg_ec_video_play_count), num(pf?.creator_profile?.video_publish_cnt_30d_med),
        h?.n ?? 0, h?.vid ?? 0, h?.open ?? 0, h?.last ?? "", h ? [...h.staff].join("/") : "",
        a.product?.id ?? "", a.product?.title ?? "", a.product?.sku_id ?? "", a.product?.sku_name ?? "", skuMap.get(a.product?.sku_id ?? "") ?? "",
        a.commission_rate === undefined ? "" : String(a.commission_rate), a.is_approvable === undefined ? "" : a.is_approvable ? "是" : "否",
        (a.disapprovable_reasons ?? []).join("/"), a.partner_name ?? "", fmtTime(a.approve_expiration_time, shop),
      ]);
    }
    pageToken = r.data?.next_page_token ?? "";
  } while (pageToken && Date.now() - started < SOFT_MS);
  return {
    kind: "samples", columns: SAMPLE_COLUMNS, rows,
    next_cursor: pageToken && !errors.some((e) => e.startsWith("sample_applications")) ? { page_token: pageToken, done } : null,
    progress: { done, total, unit: "条申样" },
    meta: { status, unfulfilled_after_days: UNFULFILLED_AFTER_DAYS, missing_rate: rates.size ? null : "汇率表为空" }, errors,
  };
}
const normHandle = (h: string) => String(h ?? "").trim().replace(/^@+/, "").replace(/\s+/g, "").toLowerCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const started = Date.now();
  try {
    await requireAdmin(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const shop = await loadShop(b.shop_id);
    const kind = String(b.kind ?? "");
    if (kind === "orders") return json(await exportOrders(shop, b, started));
    if (kind === "finance") return json(await exportFinance(shop, b, started));
    if (kind === "products") return json(await exportProducts(shop, b, started));
    if (kind === "affiliate") return json(await exportAffiliate(shop, b, started));
    if (kind === "samples") return json(await exportSamples(shop, b, started));
    bad("kind 只能是 orders / finance / products / affiliate / samples");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
