-- 评论查看：接口口径更正（2026-11-25 负责人「接口核对」实测）
-- 商品表现详情的 ratings[] 不受 start_date_ge / end_date_lt 影响，返回的是该 listing 截至调用时的**全部历史累计**星级分布
-- （JP 3 个商品：接口 − 抓取表全部历史 = 11-09 之后新增的 1～4 条）。
-- 改为每晚存一份累计快照（review_snapshot），当日新增 = 今晚快照 − 上一份快照（review_daily source='api'）；
-- 第一份快照没有上一份时，差额 = 快照 − 已知累计（抓取表 + 已有接口行），记 source='api_init'：
--   计入累计平均分，不计入每日评价数（它是多天的合计，日期不准）。

alter table public.review_daily drop constraint if exists review_daily_source_check;
alter table public.review_daily add constraint review_daily_source_check check (source in ('crawl', 'api', 'api_init'));

create table if not exists public.review_snapshot (
  shop_key   text not null,
  product_id text not null,
  d          date not null,            -- 快照归属日 = 店铺当地昨天（每晚北京 00:35 起拉取）
  s1 int not null default 0,
  s2 int not null default 0,
  s3 int not null default 0,
  s4 int not null default 0,
  s5 int not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (shop_key, product_id, d)
);
alter table public.review_snapshot enable row level security;
revoke all on public.review_snapshot from anon, authenticated;

-- 旧版（按日期二分）写入的接口行口径错误，全部清掉、游标重置（实际 2026-11-25 尚未写入任何接口行）
delete from public.review_daily where source in ('api', 'api_init');
update public.review_shops set api_until = null, latest_available_date = null, state = '{}'::jsonb, last_error = null;

drop function if exists public.review_series(text[], date, date, text);
drop function if exists public.review_table(text[], date, date, text);
drop function if exists public.review_effective(text[], text, date);

-- rated：计入累计（crawl 只在 d <= crawl_until；api / api_init 只在 d > crawl_until）；init：是否初始差额
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
    and (coalesce(p_q, '') = '' or p.product_id ilike '%' || p_q || '%' or coalesce(p.seller_sku, '') ilike '%' || p_q || '%');
$$;

-- 趋势：base = 区间前累计（含初始差额）；days 逐日新增（不含初始差额）+ i1..i5 当天的初始差额（只加进累计线）
create or replace function public.review_series(p_shops text[], p_from date, p_to date, p_q text default null)
returns jsonb language sql stable set search_path = public as $$
  with e as (select * from review_effective(p_shops, p_q, p_to))
  select jsonb_build_object(
    'base', (select jsonb_build_array(coalesce(sum(s1), 0), coalesce(sum(s2), 0), coalesce(sum(s3), 0), coalesce(sum(s4), 0), coalesce(sum(s5), 0))
             from e where rated and d < p_from),
    'days', coalesce((select jsonb_agg(x order by x.d) from (
               select d,
                      coalesce(sum(s1) filter (where rated and not init), 0) s1, coalesce(sum(s2) filter (where rated and not init), 0) s2,
                      coalesce(sum(s3) filter (where rated and not init), 0) s3, coalesce(sum(s4) filter (where rated and not init), 0) s4,
                      coalesce(sum(s5) filter (where rated and not init), 0) s5,
                      coalesce(sum(s1) filter (where rated and init), 0) i1, coalesce(sum(s2) filter (where rated and init), 0) i2,
                      coalesce(sum(s3) filter (where rated and init), 0) i3, coalesce(sum(s4) filter (where rated and init), 0) i4,
                      coalesce(sum(s5) filter (where rated and init), 0) i5,
                      coalesce(sum(orders), 0) orders
               from e where d >= p_from group by d) x), '[]'::jsonb),
    'products', (select count(distinct (shop_key, product_id)) from e)
  );
$$;

-- 链接表：base 区间前累计（含初始差额）、range 区间内逐日新增（不含）、rinit 区间内初始差额（只进累计）
create or replace function public.review_table(p_shops text[], p_from date, p_to date, p_q text default null)
returns jsonb language sql stable set search_path = public as $$
  with e as (select * from review_effective(p_shops, p_q, p_to)),
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
      coalesce(sum(orders) filter (where d >= p_from), 0) ord
    from e group by shop_key, product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'site', g.shop_key, 'pid', g.product_id, 'sku', p.seller_sku, 'below', p.below_4,
    'base', jsonb_build_array(b1, b2, b3, b4, b5), 'range', jsonb_build_array(r1, r2, r3, r4, r5),
    'rinit', jsonb_build_array(i1, i2, i3, i4, i5), 'orders', ord)), '[]'::jsonb)
  from g join review_products p using (shop_key, product_id);
$$;

-- 差评提示：累计含初始差额；近 30 天评论/差评不含
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
    select c.*, p.seller_sku, p.below_4, p.alerted_at,
           (c1 + c2 + c3 + c4 + c5) n,
           (c1 + 2 * c2 + 3 * c3 + 4 * c4 + 5 * c5)::numeric / nullif(c1 + c2 + c3 + c4 + c5, 0) avg
    from _cum c join review_products p using (shop_key, product_id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'site', shop_key, 'pid', product_id, 'sku', seller_sku, 'avg', round(avg, 2), 'n', n,
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

revoke all on function public.review_effective(text[], text, date), public.review_series(text[], date, date, text),
  public.review_table(text[], date, date, text), public.review_alert_scan(boolean) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
