// TikTok Shop 订单接口原文 → 后台「订单导出」同列名同格式的行（一行一个 SKU）。
// 从 supabase/functions/tts-export/index.ts 抽出的同一份转换逻辑（纯函数，前端/服务端/对账脚本共用）；
// 两边改动必须同步。入库原文已去掉空值与 0（prune），缺失字段按 0 / 空处理。
export type Cell = string | number | null;
type Shop = { region: string | null };
const bad = (m: string): never => { throw new Error(m); };

const REGION_UTC_OFFSET: Record<string, number> = { PH: 8, MY: 8, SG: 8, TH: 7, VN: 7, ID: 7, JP: 9, GB: 0, US: -8, MX: -6, BR: -3 };
function offsetOf(shop: Shop): number {
  const off = REGION_UTC_OFFSET[(shop.region ?? "").toUpperCase()];
  if (off === undefined) bad(`未配置 ${shop.region} 的时区`);
  return off;
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

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100) || 0;
const money = (c: number) => Number((c / 100).toFixed(2));
const num = (v: unknown): Cell => (v === undefined || v === null || v === "" ? null : Number(v));

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
export const ORDER_COLUMNS_TH = ORDER_COLUMNS.flatMap((c) =>
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
export type Order = {
  id: string; status?: string; create_time?: number; paid_time?: number; rts_time?: number; collection_time?: number; delivery_time?: number;
  cancel_time?: number; cancellation_initiator?: string; cancel_reason?: string; fulfillment_type?: string; tracking_number?: string;
  delivery_option_name?: string; shipping_provider?: string; buyer_message?: string; payment_method_name?: string; seller_note?: string;
  packages?: Array<{ id?: string }>; line_items?: LineItem[]; payment?: Record<string, string>; warehouse_id?: string;
  recipient_address?: { postal_code?: string; district_info?: Array<{ address_level?: string; address_name?: string }> };
};

/** 退货退款（Search Returns）按订单汇总：每个 SKU 的退货件数、退款金额（分） */
export type ReturnInfo = Map<string, { qty: number; refund: number }>;
export type Enrich = { warehouses: Map<string, string>; returns: Map<string, ReturnInfo> };


export function orderRows(o: Order, shop: Shop, th: boolean, en?: Enrich): Cell[][] {
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


/** 入库的退货（tts_orders.returns）→ orderRows 需要的 ReturnInfo（金额按分）。
 *  新结构（1125.269 起）：每条带 return_status，逐 SKU 一行；旧结构：{sku_id, qty, refund_total}（已按「未拒绝未取消」过滤）。
 *  countStatus 决定哪些状态的申请计入「Return/Refund」——口径以与后台导出逐单对账结果为准（见 docs/AUTO_DATA_PLAN.md）。 */
export type StoredReturn = { sku_id: string; qty?: number; refund_total: number; return_status?: string; return_type?: string; return_id?: string };
export function returnsInfo(
  list: StoredReturn[] | null | undefined,
  countStatus: (status: string) => boolean = (st) => !/REJECT|CANCEL/i.test(st),
): ReturnInfo | undefined {
  if (!list?.length) return undefined;
  const m: ReturnInfo = new Map();
  for (const r of list) {
    if (r.return_status !== undefined && !countStatus(r.return_status)) continue;
    const a = m.get(r.sku_id) ?? { qty: 0, refund: 0 };
    a.qty += r.qty ?? 1;
    a.refund += Math.round(Number(r.refund_total) * 100);
    m.set(r.sku_id, a);
  }
  return m.size ? m : undefined;
}
