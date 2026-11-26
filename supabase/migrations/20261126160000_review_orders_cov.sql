-- 评论查看：留评率口径修正（负责人 2026-11-26 发现留评率偏高，如 TH 50%、MX-AR 98%）
-- 原因：出单量只从首次同步（抓取表截止日次日）开始有，而区间评价数大多来自抓取表 → 分子覆盖 90 天、分母只覆盖十几天。
-- 修正：
--   1. review_shops.orders_from = 已有出单数据的最早日期；每晚同步完成后自动往前补出单到「截止日 − 179 天」（Edge Function reviews）。
--   2. 留评率 / 订单差评率只在「评价和出单都已知」的日子里算：d >= orders_from，且不在初始差额覆盖的日子里
--      （crawl_until 之后到首个快照日之间的评价是一笔合计，分不到天，这几天的出单也不计入分母）。
--   出单量列仍显示区间内全部已知出单。

alter table public.review_shops add column if not exists orders_from date;
update public.review_shops s set orders_from = x.m
  from (select shop_key, min(d) m from public.review_daily where source = 'api' and orders is not null group by 1) x
 where x.shop_key = s.shop_key and s.orders_from is null;

drop function if exists public.review_table(text[], date, date, text);
create or replace function public.review_table(p_shops text[], p_from date, p_to date, p_q text default null)
returns jsonb language sql stable set search_path = public as $$
  with e as (select * from review_effective(p_shops, p_q, p_to)),
  pm as (  -- 每个 listing 的初始差额日（没有则为 null）
    select shop_key, product_id, max(d) filter (where init) init_d from e group by 1, 2
  ),
  x as (
    select e.*, (e.d >= coalesce(sh.orders_from, date '9999-12-31')
                 and (e.d <= coalesce(sh.crawl_until, date '1900-01-01') or e.d > coalesce(pm.init_d, date '1900-01-01'))) as cov
    from e join pm using (shop_key, product_id) left join review_shops sh using (shop_key)
  ),
  g as (
    select shop_key, product_id,
      coalesce(sum(s1) filter (where rated and d < p_from), 0) b1, coalesce(sum(s2) filter (where rated and d < p_from), 0) b2,
      coalesce(sum(s3) filter (where rated and d < p_from), 0) b3, coalesce(sum(s4) filter (where rated and d < p_from), 0) b4,
      coalesce(sum(s5) filter (where rated and d < p_from), 0) b5,
      coalesce(sum(s1) filter (where rated and not init and d >= p_from), 0) r1, coalesce(sum(s2) filter (where rated and not init and d >= p_from), 0) r2,
      coalesce(sum(s3) filter (where rated and not init and d >= p_from), 0) r3, coalesce(sum(s4) filter (where rated and not init and d >= p_from), 0) r4,
      coalesce(sum(s5) filter (where rated and not init and d >= p_from), 0) r5,
      coalesce(sum(s1) filter (where rated and init and d >= p_from), 0) i1, coalesce(sum(s2) filter (where rated and init and d >= p_from), 0) i2,
      coalesce(sum(s3) filter (where rated and init and d >= p_from), 0) i3, coalesce(sum(s4) filter (where rated and init and d >= p_from), 0) i4,
      coalesce(sum(s5) filter (where rated and init and d >= p_from), 0) i5,
      coalesce(sum(orders) filter (where d >= p_from), 0) ord,
      -- 比率用：评价和出单都已知的日子
      coalesce(sum(s1 + s2 + s3 + s4 + s5) filter (where rated and not init and cov and d >= p_from), 0) cov_n,
      coalesce(sum(s1 + s2) filter (where rated and not init and cov and d >= p_from), 0) cov_bad,
      coalesce(sum(orders) filter (where cov and d >= p_from), 0) cov_ord
    from x group by shop_key, product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'site', g.shop_key, 'pid', g.product_id, 'sku', p.seller_sku, 'below', p.below_4,
    'base', jsonb_build_array(b1, b2, b3, b4, b5), 'range', jsonb_build_array(r1, r2, r3, r4, r5),
    'rinit', jsonb_build_array(i1, i2, i3, i4, i5), 'orders', ord,
    'cov_n', cov_n, 'cov_bad', cov_bad, 'cov_ord', cov_ord)), '[]'::jsonb)
  from g join review_products p using (shop_key, product_id);
$$;
revoke all on function public.review_table(text[], date, date, text) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
