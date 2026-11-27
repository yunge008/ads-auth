-- 评论查看：listing 名称（负责人 2026-11-27：SKU 后面跟 listing 名称，筛选框也能按名称搜）
-- review_products.title 来源：上传抓取表时的「商品名称」列；没有的由每晚同步调 Get Product 补（每个商品只补一次）。
-- 重建 review_effective（筛选加 title）、review_table / review_alert_scan / review_list（返回 title）。

alter table public.review_products add column if not exists title text;

create or replace function public.review_effective(p_shops text[], p_q text, p_to date)
returns table (shop_key text, product_id text, d date, s1 int, s2 int, s3 int, s4 int, s5 int, orders int, rated boolean, init boolean)
language sql stable set search_path = public as $$
  select r.shop_key, r.product_id, r.d, r.s1, r.s2, r.s3, r.s4, r.s5,
         case when r.source = 'api' then r.orders end,
         (r.source = 'crawl' and r.d <= coalesce(sh.crawl_until, date '1900-01-01'))
           or (r.source in ('api', 'api_init') and r.d > coalesce(sh.crawl_until, date '1900-01-01')),
         r.source = 'api_init'
  from review_daily r
  join review_products p on p.shop_key = r.shop_key and p.product_id = r.product_id
  left join review_shops sh on sh.shop_key = r.shop_key
  where r.d <= p_to
    and (p_shops is null or cardinality(p_shops) = 0 or r.shop_key = any (p_shops))
    and (coalesce(p_q, '') = '' or p.product_id ilike '%' || p_q || '%' or coalesce(p.seller_sku, '') ilike '%' || p_q || '%' or coalesce(p.title, '') ilike '%' || p_q || '%');
$$;

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
    'site', g.shop_key, 'pid', g.product_id, 'sku', p.seller_sku, 'title', p.title, 'below', p.below_4,
    'base', jsonb_build_array(b1, b2, b3, b4, b5), 'range', jsonb_build_array(r1, r2, r3, r4, r5),
    'rinit', jsonb_build_array(i1, i2, i3, i4, i5), 'orders', ord,
    'cov_n', cov_n, 'cov_bad', cov_bad, 'cov_ord', cov_ord)), '[]'::jsonb)
  from g join review_products p using (shop_key, product_id);
$$;

create or replace function public.review_alert_scan(p_commit boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  cfg record;
  res jsonb;
  today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  select * into cfg from review_settings where id = 1;
  create temp table _cum on commit drop as
    select e.shop_key, e.product_id,
           coalesce(sum(e.s1) filter (where rated), 0) c1, coalesce(sum(e.s2) filter (where rated), 0) c2,
           coalesce(sum(e.s3) filter (where rated), 0) c3, coalesce(sum(e.s4) filter (where rated), 0) c4,
           coalesce(sum(e.s5) filter (where rated), 0) c5,
           sum(e.s1 + e.s2 + e.s3 + e.s4 + e.s5) filter (where rated and not init and e.d > today - 30) n30,
           sum(e.s1 + e.s2) filter (where rated and not init and e.d > today - 30) bad30
    from review_effective(null, null, today) e group by 1, 2;
  create temp table _st on commit drop as
    select c.*, p.seller_sku, p.title, p.below_4, p.alerted_at,
           (c1 + c2 + c3 + c4 + c5) n,
           (c1 + 2 * c2 + 3 * c3 + 4 * c4 + 5 * c5)::numeric / nullif(c1 + c2 + c3 + c4 + c5, 0) avg
    from _cum c join review_products p using (shop_key, product_id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'site', shop_key, 'pid', product_id, 'sku', seller_sku, 'title', title, 'avg', round(avg, 2), 'n', n,
           'n30', coalesce(n30, 0), 'bad30', coalesce(bad30, 0), 'alerted_at', alerted_at, 'new', not below_4)
         order by avg), '[]'::jsonb)
    into res
    from _st where n >= cfg.min_reviews and avg < cfg.threshold;
  if p_commit then
    update review_products p set below_4 = true, alerted_at = now(), updated_at = now()
      from _st s where s.shop_key = p.shop_key and s.product_id = p.product_id
       and s.n >= cfg.min_reviews and s.avg < cfg.threshold and not p.below_4;
    update review_products p set below_4 = false, updated_at = now()
      from _st s where s.shop_key = p.shop_key and s.product_id = p.product_id
       and p.below_4 and not (s.n >= cfg.min_reviews and s.avg < cfg.threshold);
  end if;
  return jsonb_build_object('min_reviews', cfg.min_reviews, 'threshold', cfg.threshold, 'items', res);
end $$;

drop function if exists public.review_list(text[], date, date, int[], text, int, int);
create or replace function public.review_list(p_shops text[], p_from date, p_to date, p_stars int[], p_q text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = public as $$
  with sh as (select shop_key, crawl_until from review_shops),
  t as (
    select 'text'::text kind, r.review_at ts, r.shop_key, r.product_id, coalesce(r.seller_sku, p.seller_sku) sku, p.title, r.star,
           r.content, r.content_zh, r.reply, r.reply_zh, r.order_id, r.img_count, r.imgs, null::jsonb counts, false init
    from review_texts r left join review_products p using (shop_key, product_id)
    where r.review_at >= p_from and r.review_at < p_to + 1
      and (p_shops is null or cardinality(p_shops) = 0 or r.shop_key = any (p_shops))
      and (p_stars is null or cardinality(p_stars) = 0 or r.star = any (p_stars))
      and (coalesce(p_q, '') = '' or r.product_id ilike '%' || p_q || '%' or coalesce(r.seller_sku, p.seller_sku, '') ilike '%' || p_q || '%' or coalesce(p.title, '') ilike '%' || p_q || '%')
  ),
  g as (  -- 空档占位：抓取截止日之后接口新增（正数）的评价，没有内容
    select 'gap'::text kind, (d + time '23:59:59') ts, d.shop_key, d.product_id, p.seller_sku sku, p.title, null::smallint star,
           null::text content, null::text content_zh, null::text reply, null::text reply_zh, null::text order_id, 0 img_count, null::jsonb imgs,
           jsonb_build_array(
             case when (p_stars is null or cardinality(p_stars) = 0 or 1 = any (p_stars)) then greatest(d.s1, 0) else 0 end,
             case when (p_stars is null or cardinality(p_stars) = 0 or 2 = any (p_stars)) then greatest(d.s2, 0) else 0 end,
             case when (p_stars is null or cardinality(p_stars) = 0 or 3 = any (p_stars)) then greatest(d.s3, 0) else 0 end,
             case when (p_stars is null or cardinality(p_stars) = 0 or 4 = any (p_stars)) then greatest(d.s4, 0) else 0 end,
             case when (p_stars is null or cardinality(p_stars) = 0 or 5 = any (p_stars)) then greatest(d.s5, 0) else 0 end) counts,
           d.source = 'api_init' init
    from review_daily d
    join review_products p using (shop_key, product_id)
    left join sh using (shop_key)
    where d.source in ('api', 'api_init') and d.d > coalesce(sh.crawl_until, date '1900-01-01')
      and d.d >= p_from and d.d <= p_to
      and (p_shops is null or cardinality(p_shops) = 0 or d.shop_key = any (p_shops))
      and (coalesce(p_q, '') = '' or d.product_id ilike '%' || p_q || '%' or coalesce(p.seller_sku, '') ilike '%' || p_q || '%' or coalesce(p.title, '') ilike '%' || p_q || '%')
  ),
  g2 as (select * from g where (counts->>0)::int + (counts->>1)::int + (counts->>2)::int + (counts->>3)::int + (counts->>4)::int > 0),
  a as (select * from t union all select * from g2)
  select jsonb_build_object(
    'total', (select count(*) from a),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.ts desc) from (select * from a order by ts desc limit p_limit offset p_offset) x), '[]'::jsonb));
$$;

revoke all on function public.review_effective(text[], text, date), public.review_table(text[], date, date, text),
  public.review_alert_scan(boolean), public.review_list(text[], date, date, int[], text, int, int) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
