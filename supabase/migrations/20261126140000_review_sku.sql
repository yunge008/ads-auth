-- 评论查看：SKU 维度（负责人 2026-11-25：PID = listing 评分，可展开看 SKU 评分，按评价数从高到低）
-- 接口只有 listing（PID）级累计星级，没有 SKU 级；SKU 维度只能来自抓取表（每条评价带 SKU ID / SKU 规格）。
-- 所以 SKU 数据只覆盖抓取表日期段，接口同步的日期没有 SKU 拆分。需重新上传抓取表才会有 SKU 数据。

create table if not exists public.review_sku_daily (
  shop_key   text not null,
  product_id text not null,
  sku_id     text not null,
  d          date not null,
  s1 int not null default 0,
  s2 int not null default 0,
  s3 int not null default 0,
  s4 int not null default 0,
  s5 int not null default 0,
  primary key (shop_key, product_id, sku_id, d)
);

create table if not exists public.review_skus (
  shop_key   text not null,
  product_id text not null,
  sku_id     text not null,
  sku_spec   text,                       -- 抓取表「SKU 规格」（该 SKU 最常见的写法）
  primary key (shop_key, product_id, sku_id)
);

alter table public.review_sku_daily enable row level security;
alter table public.review_skus enable row level security;
revoke all on public.review_sku_daily, public.review_skus from anon, authenticated;

-- 某个 listing 的 SKU 表：base = 区间前累计，range = 区间内（只到抓取表覆盖日）
create or replace function public.review_sku_table(p_shop text, p_pid text, p_from date, p_to date)
returns jsonb language sql stable set search_path = public as $$
  with g as (
    select r.sku_id,
      coalesce(sum(s1) filter (where d < p_from), 0) b1, coalesce(sum(s2) filter (where d < p_from), 0) b2,
      coalesce(sum(s3) filter (where d < p_from), 0) b3, coalesce(sum(s4) filter (where d < p_from), 0) b4,
      coalesce(sum(s5) filter (where d < p_from), 0) b5,
      coalesce(sum(s1) filter (where d >= p_from), 0) r1, coalesce(sum(s2) filter (where d >= p_from), 0) r2,
      coalesce(sum(s3) filter (where d >= p_from), 0) r3, coalesce(sum(s4) filter (where d >= p_from), 0) r4,
      coalesce(sum(s5) filter (where d >= p_from), 0) r5
    from review_sku_daily r
    where r.shop_key = p_shop and r.product_id = p_pid and r.d <= p_to
    group by r.sku_id
  )
  select jsonb_build_object(
    'crawl_until', (select crawl_until from review_shops where shop_key = p_shop),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'sku_id', g.sku_id, 'spec', k.sku_spec,
      'base', jsonb_build_array(b1, b2, b3, b4, b5), 'range', jsonb_build_array(r1, r2, r3, r4, r5))
      order by (b1 + b2 + b3 + b4 + b5 + r1 + r2 + r3 + r4 + r5) desc), '[]'::jsonb))
  from g left join review_skus k on k.shop_key = p_shop and k.product_id = p_pid and k.sku_id = g.sku_id;
$$;
revoke all on function public.review_sku_table(text, text, date, date) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
