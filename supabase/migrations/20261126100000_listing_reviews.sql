-- Listing 评价监控（「评论查看」页）。计划与口径：docs/LISTING_REVIEWS_PLAN.md
-- 数据：
--   review_daily   每个 listing 每天 1–5 星条数（source=crawl 来自上传的抓取表；source=api 来自商品表现详情接口）+ 出单量（仅 api）
--                  生效规则：d <= review_shops.crawl_until 用 crawl，之后用 api；出单量只看 api 行
--   review_texts   只存有留言或有回复的评价（原文 + 中文 + 回复），不存用户名、图片链接
--   review_products listing 清单（卖家 SKU、<4.0 提醒状态）
--   review_shops    每站点抓取覆盖范围 + 每晚同步游标
--   review_settings 差评提示门槛（单行）
--   review_uploads  上传记录
-- 全部只给 service_role（Edge Function `reviews`）读写。

create table if not exists public.review_daily (
  shop_key   text not null,             -- 站点：PH / TH / MY / VN / SG / JP / US / MX-AR / MX-NE / MX-SJ / PH2
  product_id text not null,
  d          date not null,             -- 店铺当地日期
  source     text not null check (source in ('crawl', 'api')),
  s1 int not null default 0,
  s2 int not null default 0,
  s3 int not null default 0,
  s4 int not null default 0,
  s5 int not null default 0,
  orders int,                           -- 仅 api：接口 intervals[].sales.orders
  updated_at timestamptz not null default now(),
  primary key (shop_key, product_id, d, source)
);
create index if not exists review_daily_shop_d on public.review_daily (shop_key, d);

create table if not exists public.review_texts (
  review_id  text primary key,
  shop_key   text not null,
  product_id text not null,
  sku_id     text,
  seller_sku text,                      -- 抓取表「SKU 规格」
  star       smallint not null,
  review_at  timestamp,                 -- 抓取表「评论时间」原样（未核验时区）
  order_id   text,
  content    text,
  content_zh text,
  reply      text,
  reply_zh   text,
  img_count  smallint not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists review_texts_prod on public.review_texts (shop_key, product_id, review_at desc);

create table if not exists public.review_products (
  shop_key   text not null,
  product_id text not null,
  seller_sku text,
  below_4    boolean not null default false,   -- 当前是否处于「低于提示分数」状态（名字沿用 4.0，门槛可在页面改）
  alerted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (shop_key, product_id)
);

create table if not exists public.review_shops (
  shop_key    text primary key,
  crawl_from  date,
  crawl_until date,                      -- 抓取表覆盖到的最后一天；之后用接口
  api_until   date,                      -- 接口已同步到的最后一天
  latest_available_date date,
  state       jsonb not null default '{}'::jsonb,  -- 每晚同步游标 {run_date, products[], idx, end}
  last_run_at timestamptz,
  last_error  text
);

create table if not exists public.review_settings (
  id          int primary key default 1 check (id = 1),
  min_reviews int not null default 10,
  threshold   numeric(3, 2) not null default 4.00,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
insert into public.review_settings (id) values (1) on conflict do nothing;

create table if not exists public.review_uploads (
  id          uuid primary key default gen_random_uuid(),
  shop_key    text not null,
  file_name   text not null,
  range_from  date not null,
  range_to    date not null,
  rows_total  int not null default 0,
  rows_in_range int not null default 0,
  rows_text   int not null default 0,
  products    int not null default 0,
  status      text not null default 'UPLOADING',
  uploaded_by text,
  created_at  timestamptz not null default now()
);

alter table public.review_daily enable row level security;
alter table public.review_texts enable row level security;
alter table public.review_products enable row level security;
alter table public.review_shops enable row level security;
alter table public.review_settings enable row level security;
alter table public.review_uploads enable row level security;
revoke all on public.review_daily, public.review_texts, public.review_products, public.review_shops,
  public.review_settings, public.review_uploads from anon, authenticated;

-- ── 页面查询 ──────────────────────────────────────────────────────────────
-- 生效的星级行：crawl 只在 d <= crawl_until 生效，api 只在 d > crawl_until 生效
create or replace function public.review_effective(p_shops text[], p_q text, p_to date)
returns table (shop_key text, product_id text, d date, s1 int, s2 int, s3 int, s4 int, s5 int, orders int, rated boolean)
language sql stable set search_path = public as $$
  select r.shop_key, r.product_id, r.d, r.s1, r.s2, r.s3, r.s4, r.s5,
         case when r.source = 'api' then r.orders end,
         (r.source = 'crawl' and r.d <= coalesce(sh.crawl_until, date '1900-01-01'))
           or (r.source = 'api' and r.d > coalesce(sh.crawl_until, date '1900-01-01'))
  from review_daily r
  join review_products p on p.shop_key = r.shop_key and p.product_id = r.product_id
  left join review_shops sh on sh.shop_key = r.shop_key
  where r.d <= p_to
    and (p_shops is null or cardinality(p_shops) = 0 or r.shop_key = any (p_shops))
    and (coalesce(p_q, '') = '' or p.product_id ilike '%' || p_q || '%' or coalesce(p.seller_sku, '') ilike '%' || p_q || '%');
$$;

-- 趋势：区间前的累计基数 + 区间内逐日（星级 + 出单）
create or replace function public.review_series(p_shops text[], p_from date, p_to date, p_q text default null)
returns jsonb language sql stable set search_path = public as $$
  with e as (select * from review_effective(p_shops, p_q, p_to))
  select jsonb_build_object(
    'base', (select jsonb_build_array(coalesce(sum(s1), 0), coalesce(sum(s2), 0), coalesce(sum(s3), 0), coalesce(sum(s4), 0), coalesce(sum(s5), 0))
             from e where rated and d < p_from),
    'days', coalesce((select jsonb_agg(x order by x.d) from (
               select d,
                      coalesce(sum(s1) filter (where rated), 0) s1, coalesce(sum(s2) filter (where rated), 0) s2,
                      coalesce(sum(s3) filter (where rated), 0) s3, coalesce(sum(s4) filter (where rated), 0) s4,
                      coalesce(sum(s5) filter (where rated), 0) s5, coalesce(sum(orders), 0) orders
               from e where d >= p_from group by d) x), '[]'::jsonb),
    'products', (select count(distinct (shop_key, product_id)) from e)
  );
$$;

-- 链接表：每个 listing 的区间前累计、区间内星级、区间出单
create or replace function public.review_table(p_shops text[], p_from date, p_to date, p_q text default null)
returns jsonb language sql stable set search_path = public as $$
  with e as (select * from review_effective(p_shops, p_q, p_to)),
  g as (
    select shop_key, product_id,
      coalesce(sum(s1) filter (where rated and d < p_from), 0) b1, coalesce(sum(s2) filter (where rated and d < p_from), 0) b2,
      coalesce(sum(s3) filter (where rated and d < p_from), 0) b3, coalesce(sum(s4) filter (where rated and d < p_from), 0) b4,
      coalesce(sum(s5) filter (where rated and d < p_from), 0) b5,
      coalesce(sum(s1) filter (where rated and d >= p_from), 0) r1, coalesce(sum(s2) filter (where rated and d >= p_from), 0) r2,
      coalesce(sum(s3) filter (where rated and d >= p_from), 0) r3, coalesce(sum(s4) filter (where rated and d >= p_from), 0) r4,
      coalesce(sum(s5) filter (where rated and d >= p_from), 0) r5,
      coalesce(sum(orders) filter (where d >= p_from), 0) ord
    from e group by shop_key, product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'site', g.shop_key, 'pid', g.product_id, 'sku', p.seller_sku, 'below', p.below_4,
    'base', jsonb_build_array(b1, b2, b3, b4, b5), 'range', jsonb_build_array(r1, r2, r3, r4, r5), 'orders', ord)), '[]'::jsonb)
  from g join review_products p using (shop_key, product_id);
$$;

-- ── 差评提示 ──────────────────────────────────────────────────────────────
-- 当前累计（全部历史）低于门槛且评价数达标的 listing；p_commit=true 时更新 below_4 / alerted_at，
-- 返回「本次新跌破」的（之前不在 below_4 状态）。回到门槛及以上时清除 below_4，下次跌破再提示（负责人 2026-11-25 选 B）。
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
           sum(e.s1) filter (where rated) c1, sum(e.s2) filter (where rated) c2, sum(e.s3) filter (where rated) c3,
           sum(e.s4) filter (where rated) c4, sum(e.s5) filter (where rated) c5,
           sum(e.s1 + e.s2 + e.s3 + e.s4 + e.s5) filter (where rated and e.d > today - 30) n30,
           sum(e.s1 + e.s2) filter (where rated and e.d > today - 30) bad30
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

-- ── 上传：评价内容 upsert（中文/回复为空时不覆盖已有值）──────────────────
create or replace function public.review_texts_upsert(p_rows jsonb)
returns int language sql set search_path = public as $$
  with x as (
    select * from jsonb_to_recordset(p_rows) as t(
      review_id text, shop_key text, product_id text, sku_id text, seller_sku text, star smallint, review_at timestamp,
      order_id text, content text, content_zh text, reply text, reply_zh text, img_count smallint)
  ), up as (
    insert into review_texts as r (review_id, shop_key, product_id, sku_id, seller_sku, star, review_at, order_id,
                                   content, content_zh, reply, reply_zh, img_count)
    select review_id, shop_key, product_id, sku_id, seller_sku, star, review_at, order_id,
           content, content_zh, reply, reply_zh, coalesce(img_count, 0) from x
    on conflict (review_id) do update set
      star = excluded.star, review_at = excluded.review_at, seller_sku = coalesce(excluded.seller_sku, r.seller_sku),
      content = coalesce(excluded.content, r.content), content_zh = coalesce(excluded.content_zh, r.content_zh),
      reply = coalesce(excluded.reply, r.reply), reply_zh = coalesce(excluded.reply_zh, r.reply_zh),
      img_count = excluded.img_count, updated_at = now()
    returning 1
  ) select count(*)::int from up;
$$;

-- 卖家 SKU 补全：先用商品映射表（sku_product_map，按站点），没有的用抓取表 SKU 规格里最常见的
create or replace function public.review_products_fill_sku()
returns int language sql set search_path = public as $$
  with m as (
    select p.shop_key, p.product_id,
      coalesce(
        (select string_agg(distinct s.merchant_sku, ' / ') from sku_product_map s
          where s.country = p.shop_key and s.product_id = p.product_id),
        (select t.seller_sku from review_texts t where t.shop_key = p.shop_key and t.product_id = p.product_id and t.seller_sku is not null
          group by t.seller_sku order by count(*) desc limit 1)) sku
    from review_products p where p.seller_sku is null
  ), u as (
    update review_products p set seller_sku = m.sku, updated_at = now() from m
     where m.shop_key = p.shop_key and m.product_id = p.product_id and m.sku is not null returning 1
  ) select count(*)::int from u;
$$;

revoke all on function public.review_effective(text[], text, date), public.review_series(text[], date, date, text),
  public.review_table(text[], date, date, text), public.review_alert_scan(boolean), public.review_texts_upsert(jsonb),
  public.review_products_fill_sku() from public, anon, authenticated;

select public.ai_reader_refresh_grants();

-- 每晚北京 00:35 / 01:35 / 02:35 三轮（UTC 16:35 / 17:35 / 18:35），避开 tts-daily-sync（每小时第 17 分）
do $$
declare
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/reviews-cron';
begin
  if exists (select 1 from cron.job where jobname = 'reviews-nightly') then
    perform cron.unschedule('reviews-nightly');
  end if;
  perform cron.schedule('reviews-nightly', '35 16,17,18 * * *',
    format('select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{}''::jsonb, timeout_milliseconds := 600000);', url));
end $$;
