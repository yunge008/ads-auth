-- 2026-11-26 tts_orders 存量订单原文改为白名单（一次性；负责人 2026-11-26 定：订单原文按白名单入库）。
-- 这是变更不是延续：2026-11-25 的规则是「只去掉明确不需要的字段，数字/编号一律保留」，现改为只留白名单字段。
-- 白名单与 supabase/functions/tts-export/index.ts 的 slimOrder（TOP_KEEP / LI_KEEP）完全一致：
--   订单导出转换（orderRows）实际读取的字段 + product_id / is_sample_order / is_replacement_order / is_gift / update_time / region_code。
-- 核验（2026-11-26，只读通道抽 18,192 单 ≈ 10%）：本 SQL 结果与 TS 版逐单相同；白名单前后转出的导出行逐格相同（商品标题列除外，早已不入库）。
-- 不再保存：SLA 各时间、delivery_option_id、shipping_provider_id、delivery_type、order_type 等，商品行 id / package_id / 状态 / rts_time 等。
-- 执行：避开每小时第 17 分（订单同步）。执行完再单独跑一次 VACUUM FULL public.tts_orders; 才会把空间还给磁盘（见 WORKLOG）。
UPDATE public.tts_orders t SET raw = jsonb_strip_nulls(jsonb_build_object(
  'id', t.raw->'id', 'status', t.raw->'status', 'create_time', t.raw->'create_time', 'update_time', t.raw->'update_time',
  'paid_time', t.raw->'paid_time', 'rts_time', t.raw->'rts_time', 'collection_time', t.raw->'collection_time',
  'delivery_time', t.raw->'delivery_time', 'cancel_time', t.raw->'cancel_time',
  'cancellation_initiator', t.raw->'cancellation_initiator', 'cancel_reason', t.raw->'cancel_reason',
  'fulfillment_type', t.raw->'fulfillment_type', 'tracking_number', t.raw->'tracking_number',
  'delivery_option_name', t.raw->'delivery_option_name', 'shipping_provider', t.raw->'shipping_provider',
  'buyer_message', t.raw->'buyer_message', 'payment_method_name', t.raw->'payment_method_name',
  'seller_note', t.raw->'seller_note', 'warehouse_id', t.raw->'warehouse_id',
  'is_sample_order', t.raw->'is_sample_order', 'is_replacement_order', t.raw->'is_replacement_order',
  'payment', t.raw->'payment',
  'packages', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', p->'id')) ORDER BY n)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.raw->'packages') = 'array' THEN t.raw->'packages' ELSE '[]' END) WITH ORDINALITY AS x(p, n)),
  'recipient_address', CASE WHEN t.raw ? 'recipient_address' THEN jsonb_strip_nulls(jsonb_build_object(
      'postal_code', t.raw->'recipient_address'->'postal_code', 'region_code', t.raw->'recipient_address'->'region_code',
      'district_info', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('address_level', d->'address_level', 'address_name', d->'address_name')) ORDER BY n)
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.raw->'recipient_address'->'district_info') = 'array' THEN t.raw->'recipient_address'->'district_info' ELSE '[]' END) WITH ORDINALITY AS y(d, n)))) END,
  'line_items', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'sku_id', li->'sku_id', 'product_id', li->'product_id', 'seller_sku', li->'seller_sku', 'sku_name', li->'sku_name',
      'sku_type', li->'sku_type', 'original_price', li->'original_price', 'sale_price', li->'sale_price',
      'seller_discount', li->'seller_discount', 'platform_discount', li->'platform_discount', 'is_gift', li->'is_gift')) ORDER BY n)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.raw->'line_items') = 'array' THEN t.raw->'line_items' ELSE '[]' END) WITH ORDINALITY AS z(li, n))
));
