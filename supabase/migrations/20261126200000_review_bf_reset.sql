-- 评论查看：重置 TH / VN 的出单回补（2026-11-26）
-- 这两个店在新版 reviews（起点自动后挪 + 失败重试，1126.322）部署前，用旧代码跑了回补：
-- 从截止日前 179 天起查报 28001022，失败商品被跳过，旧代码仍把 orders_from 记成 2026-05-29
-- （VN 库里实际最早出单 11-10；TH 后来用新代码补到 05-30，但旧代码那轮失败的商品没有重试）。
-- MX-AR / MX-NE / MX-SJ / US 已用新代码补完（orders_from 05-31，无失败），不用重置。
-- 把 orders_from 改回库里实际最早出单日、清掉当晚回补游标和错误；下次同步重新回补（已有出单会被覆盖成同样的值，不会重复）。
update public.review_shops s
   set orders_from = coalesce(x.first_ord, s.orders_from),
       state = s.state - 'bf_from' - 'bf_to' - 'bf_idx' - 'bf_done' - 'bf_list' - 'bf_failed' - 'bf_round' - 'bf_eff_from' - 'errors',
       last_error = null
  from (select shop_key, min(d) first_ord from public.review_daily
         where source = 'api' and orders > 0 and shop_key in ('TH', 'VN') group by 1) x
 where s.shop_key = x.shop_key;

select shop_key, orders_from from public.review_shops where shop_key in ('TH', 'VN') order by 1;
