-- 2026-11-26 tts_orders 存量订单原文按「加严黑名单」回刷（一次性）。
-- 取代同日未执行、已删除的 20261126150100_tts_orders_whitelist.sql（负责人 2026-11-26 撤回白名单，改为黑名单再筛一遍）。
-- 规则与 supabase/functions/tts-export/index.ts 的 slimOrder 完全一致（TOP_DROP / TOP_DEFAULT / LINE_ITEM_DROP / DISTRICT_DROP + 行级等值去重 + 去 false）：
--   ① 直接去掉：顶层 8 个时限字段、delivery_option_id、shipping_provider_id；商品行 sku_image、product_name、tracking_number、
--      shipping_provider_name、shipping_provider_id；省市区 iso_code、address_level_name。
--   ② 等于订单级 / 默认值才去掉（无损）：商品行 currency / rts_time / package_id / display_status / cancel_user / cancel_reason / sku_type=NORMAL；
--      顶层 delivery_type=HOME_DELIVERY、shipping_type=TIKTOK、order_type=NORMAL；顶层与商品行的 false。
-- 执行：避开每小时第 17 分（订单同步）。执行完单独跑 VACUUM FULL public.tts_orders; 把空间还给磁盘。
UPDATE public.tts_orders t
SET raw = (
  SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  FROM jsonb_each(t.raw) e
  WHERE e.key NOT IN ('tts_sla_time', 'cancel_order_sla_time', 'rts_sla_time', 'shipping_due_time', 'collection_due_time',
                      'fast_rts_sla_time', 'fast_dispatch_sla_time', 'fast_collection_sla_time', 'delivery_option_id', 'shipping_provider_id',
                      'line_items', 'recipient_address')
    AND e.value <> 'false'::jsonb
    AND NOT (e.key = 'delivery_type' AND e.value = '"HOME_DELIVERY"'::jsonb)
    AND NOT (e.key = 'shipping_type' AND e.value = '"TIKTOK"'::jsonb)
    AND NOT (e.key = 'order_type' AND e.value = '"NORMAL"'::jsonb)
)
|| CASE WHEN jsonb_typeof(t.raw->'line_items') = 'array' THEN jsonb_build_object('line_items', coalesce((
     SELECT jsonb_agg((
       SELECT coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
       FROM jsonb_each(l) f
       WHERE f.key NOT IN ('sku_image', 'product_name', 'tracking_number', 'shipping_provider_name', 'shipping_provider_id')
         AND f.value <> 'false'::jsonb
         AND NOT (f.key = 'currency'       AND f.value IS NOT DISTINCT FROM t.raw->'payment'->'currency')
         AND NOT (f.key = 'rts_time'       AND f.value IS NOT DISTINCT FROM t.raw->'rts_time')
         AND NOT (f.key = 'package_id'     AND f.value IS NOT DISTINCT FROM t.raw->'packages'->0->'id')
         AND NOT (f.key = 'display_status' AND f.value IS NOT DISTINCT FROM t.raw->'status')
         AND NOT (f.key = 'cancel_user'    AND f.value IS NOT DISTINCT FROM t.raw->'cancellation_initiator')
         AND NOT (f.key = 'cancel_reason'  AND f.value IS NOT DISTINCT FROM t.raw->'cancel_reason')
         AND NOT (f.key = 'sku_type'       AND f.value = '"NORMAL"'::jsonb)
     ) ORDER BY n)
     FROM jsonb_array_elements(t.raw->'line_items') WITH ORDINALITY AS a(l, n)
   ), '[]'::jsonb)) ELSE '{}'::jsonb END
|| CASE WHEN jsonb_typeof(t.raw->'recipient_address') = 'object' THEN jsonb_build_object('recipient_address',
     CASE WHEN jsonb_typeof(t.raw->'recipient_address'->'district_info') = 'array'
          THEN (t.raw->'recipient_address') || jsonb_build_object('district_info', coalesce((
                 SELECT jsonb_agg(d - 'iso_code' - 'address_level_name' ORDER BY n)
                 FROM jsonb_array_elements(t.raw->'recipient_address'->'district_info') WITH ORDINALITY AS b(d, n)), '[]'::jsonb))
          ELSE t.raw->'recipient_address' END) ELSE '{}'::jsonb END;
