-- SEA库存监控：每日销量（负责人 2026-11-18：不再每次重拉整个窗口订单，云端存近 60 天按 SKU ID 的日销量，滚动补拉）
--   一行 = 店铺 × SKU ID × TikTok 仓库 × 店铺本地日期 的件数（取消单 / 取消行不计）
CREATE TABLE IF NOT EXISTS public.sea_inv_sales_daily (
  shop_id      text NOT NULL,
  sku_id       text NOT NULL,
  warehouse_id text NOT NULL DEFAULT '',
  day          date NOT NULL,
  units        int  NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, sku_id, warehouse_id, day)
);
CREATE INDEX IF NOT EXISTS sea_inv_sales_daily_shop_day ON public.sea_inv_sales_daily (shop_id, day);
GRANT ALL ON public.sea_inv_sales_daily TO service_role;
ALTER TABLE public.sea_inv_sales_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only" ON public.sea_inv_sales_daily;
CREATE POLICY "service role only" ON public.sea_inv_sales_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.sea_inv_shop_sync ADD COLUMN IF NOT EXISTS sales_synced_day date;
