-- 评论查看：重置 MX-AR / MX-NE / MX-SJ / US 的出单回补（2026-11-26）
-- 这四个店回看窗口比东南亚店短，从截止日前 179 天起查报 28001022，全部商品回补失败，
-- 但旧代码仍把 orders_from 记成了 2026-05-29（库里实际最早出单：MX-AR 11-10，其余 10-01）。
-- 把 orders_from 改回实际最早出单日、清掉当晚回补游标；下次同步按新代码（起点自动后挪 + 失败重试）重新回补。
update public.review_shops s
   set orders_from = coalesce(x.first_ord, s.orders_from),
       state = s.state - 'bf_from' - 'bf_to' - 'bf_idx' - 'bf_done' - 'bf_list' - 'bf_failed' - 'bf_round' - 'bf_eff_from' - 'errors',
       last_error = null
  from (select shop_key, min(d) first_ord from public.review_daily
         where source = 'api' and orders > 0 and shop_key in ('MX-AR', 'MX-NE', 'MX-SJ', 'US') group by 1) x
 where s.shop_key = x.shop_key;

select shop_key, orders_from from public.review_shops where shop_key in ('MX-AR', 'MX-NE', 'MX-SJ', 'US') order by 1;
