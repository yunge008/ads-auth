// TikTok Shop 结算交易接口原文（tts_finance_tx.raw）→ 后台财务表「订单详情」同列名的行（订单维度，一行一笔交易）。
//
// 列 ↔ 接口字段对应关系**由数据反推**（2026-11-25，TH 2026-08～09：35549 笔交易逐笔比对手工财务表，每列均 100% 一致），
// 不是按字段名猜。合计列算法同样逐笔验证：
//   享受商家折扣后小计 = subtotal_before_discount_amount + seller_discount_amount
//   享受商家折扣后的退款小计 = refund_subtotal_before_discount_amount + seller_discount_refund_amount
//   总费用 = fee_tax_amount + shipping_cost_amount
// 结算日期 = statement_time（UTC）的日期 + 1 天（60/60 张结算单验证；接口 statement_time 全为 UTC 0 点）。
// 列名按站点不同（REGION_LABELS）。新站点接入时须用该站点手工表重跑一次反推（见 docs/AUTO_DATA_PLAN.md），未登记字段由入库同步告警。
// SKU ID / 数量：接口为订单维度，留空；汇总计算按 finance-order 现有「缺 SKU 时按订单号展开订单表 SKU 行」规则处理（待对账验证）。

export type FinCell = string | number | null;
type Tx = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const get = (o: unknown, path: string): number => {
  let cur: unknown = o;
  for (const k of path.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
  return num(cur);
};

const TX_TYPE: Record<string, string> = {
  ORDER: "订单", PLATFORM_REIMBURSEMENT: "平台赔付", LOGISTICS_REIMBURSEMENT: "物流赔付", SHIPPING_FEE_ADJUSTMENT: "运费调整",
  CHARGE_BACK: "拒付", DEDUCTIONS_INCURRED_BY_SELLER: "商责扣款",
};

/** [后台列名, 接口字段路径]，单字段直接对应（反推结果，匹配率 100%） */
export const FIN_FIELD_MAP: Array<[string, string]> = [
  ["结算总金额", "settlement_amount"],
  ["总收入", "revenue_amount"],
  ["享受折扣前小计", "revenue_breakdown.subtotal_before_discount_amount"],
  ["商家折扣", "revenue_breakdown.seller_discount_amount"],
  ["享受商家折扣前的退款小计", "revenue_breakdown.refund_subtotal_before_discount_amount"],
  ["商家折扣退款", "revenue_breakdown.seller_discount_refund_amount"],
  ["交易手续费", "fee_tax_breakdown.fee.transaction_fee_amount"],
  ["TikTok Shop 佣金费", "fee_tax_breakdown.fee.platform_commission_amount"],
  ["商家运费", "shipping_cost_amount"],
  ["实际运费", "shipping_cost_breakdown.actual_shipping_fee_amount"],
  ["平台运费减免", "shipping_cost_breakdown.supplementary_component.platform_shipping_fee_discount_amount"],
  ["买家支付运费", "shipping_cost_breakdown.supplementary_component.customer_shipping_fee"],
  ["实际退货运费", "shipping_cost_breakdown.return_shipping_fee_amount"],
  ["客户运费退款", "shipping_cost_breakdown.supplementary_component.refund_customer_shipping_fee"],
  ["联盟佣金", "fee_tax_breakdown.fee.affiliate_commission_amount"],
  ["扣除个人所得税（PIT）前的联盟佣金", "fee_tax_breakdown.fee.affiliate_commission_amount_before_pit"],
  ["联盟服务商佣金", "fee_tax_breakdown.fee.affiliate_partner_commission_amount"],
  ["联盟店铺广告佣金", "fee_tax_breakdown.fee.affiliate_ads_commission_amount"],
  ["联盟服务商店铺广告佣金", "fee_tax_breakdown.fee.tap_shop_ads_commission"],
  ["进口关税和增值税", "fee_tax_breakdown.tax.import_vat_amount"],
  ["直播特别活动服务费", "fee_tax_breakdown.fee.live_specials_fee_amount"],
  ["品牌疯狂优惠/秒杀服务费", "fee_tax_breakdown.fee.flash_sales_service_fee_amount"],
  ["电商增长服务费", "fee_tax_breakdown.fee.dynamic_commission_amount"],
  ["基础设施费", "fee_tax_breakdown.fee.vn_fix_infrastructure_fee"],
  ["商家成长服务费", "fee_tax_breakdown.fee.seller_growth_fee_amount"],
  ["超级优惠券服务费", "fee_tax_breakdown.fee.voucher_xtra_service_fee_amount"],
  ["SFP 服务费", "fee_tax_breakdown.fee.sfp_service_fee_amount"],
  ["调整金额", "adjustment_amount"],
  ["客户付款", "supplementary_component.customer_payment_amount"],
  ["客户退款", "supplementary_component.customer_refund_amount"],
  ["商家共同赞助优惠券折扣", "supplementary_component.seller_cofunded_discount_amount"],
  ["商家共同赞助优惠券折扣退款", "supplementary_component.seller_cofunded_discount_refund_amount"],
  ["平台折扣", "supplementary_component.platform_discount_amount"],
  ["平台折扣退款", "supplementary_component.platform_discount_refund_amount"],
  ["平台共同赞助优惠券折扣", "supplementary_component.platform_cofunded_discount_amount"],
  ["平台共同赞助优惠券折扣退款", "supplementary_component.platform_cofunded_discount_refund_amount"],
  ["商家运费折扣", "shipping_cost_breakdown.supplementary_component.seller_shipping_fee_discount_amount"],
];

/**
 * 同一接口字段在不同站点后台表里列名不同（反推结果）。列名决定 finance-order 归到哪一列，不能混用：
 * PH 的「物流服务费」= dynamic_commission_amount，finance-order 归 V（SFP）；TH 同字段叫「电商增长服务费」，不归 V。
 * PH：2026-08～10 共 63198 笔交易逐笔比对，100% 一致。PH2/PHL 未核验，接入时须重跑反推。
 */
const REGION_LABELS: Record<string, Record<string, string>> = {
  PH: {
    "fee_tax_breakdown.fee.dynamic_commission_amount": "物流服务费",
    "fee_tax_breakdown.fee.vn_fix_infrastructure_fee": "订单处理手续费",
  },
};
const fieldMap = (region?: string): Array<[string, string]> =>
  FIN_FIELD_MAP.map(([c, p]) => [REGION_LABELS[region ?? ""]?.[p] ?? c, p]);

export const finExportColumns = (region?: string) => [
  "结算日期", "结算单 ID", "货币", "交易类型", "订单ID/调整单ID", "SKU ID", "数量", "订单创建时间",
  "享受商家折扣后小计", "享受商家折扣后的退款小计", "总费用",
  ...fieldMap(region).map(([c]) => c),
  "相关订单 ID",
];
/** TH 列名（默认） */
export const FIN_EXPORT_COLUMNS = finExportColumns();

/** 结算日期：statement_time（UTC 秒）日期 + 1 天，格式 YYYY/MM/DD（与后台导出一致） */
export function statementDate(statementTimeIso: string | null): string {
  if (!statementTimeIso) return "";
  const d = new Date(new Date(statementTimeIso).getTime() + 86400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

export function financeRow(
  tx: { statement_id: string; statement_time: string | null; order_create_time?: string | null; raw: Tx },
  currency: string,
  localOffsetHours: number,
  region?: string,
): FinCell[] {
  const t = tx.raw;
  const type = String(t.type ?? "ORDER");
  const isOrder = type === "ORDER";
  const created = tx.order_create_time
    ? new Date(new Date(tx.order_create_time).getTime() + localOffsetHours * 3600_000).toISOString().slice(0, 19).replace("T", " ")
    : "";
  const rec: Record<string, FinCell> = {
    "结算日期": statementDate(tx.statement_time),
    "结算单 ID": tx.statement_id,
    "货币": currency,
    "交易类型": TX_TYPE[type] ?? type,
    "订单ID/调整单ID": String(isOrder ? (t.order_id ?? "") : (t.adjustment_id ?? t.id ?? "")),
    "SKU ID": "",
    "数量": null,
    "订单创建时间": created,
    "享受商家折扣后小计": r2(get(t, "revenue_breakdown.subtotal_before_discount_amount") + get(t, "revenue_breakdown.seller_discount_amount")),
    "享受商家折扣后的退款小计": r2(get(t, "revenue_breakdown.refund_subtotal_before_discount_amount") + get(t, "revenue_breakdown.seller_discount_refund_amount")),
    "总费用": r2(get(t, "fee_tax_amount") + get(t, "shipping_cost_amount")),
    "相关订单 ID": isOrder ? String(t.order_id ?? "") : String(t.adjustment_order_id ?? t.associated_order_id ?? t.order_id ?? ""),
  };
  for (const [col, path] of fieldMap(region)) rec[col] = r2(get(t, path));
  return finExportColumns(region).map((c) => rec[c] ?? null);
}
