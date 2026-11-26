-- 评论查看：「评论内容」TAB（负责人 2026-11-26）
-- 1. review_texts.imgs：评价图 [[缩略图, 原图], …]，来自抓取表「评价图」sheet（没有该 sheet 时取「评价图链接」列，缩略图 = 原图）。
--    链接是 TikTok CDN（ibyteimg），抓取工具报告「链接中未发现有效期参数」，2026-11-26 实测无 Referer / 带 Referer 均可访问；是否会过期未核验。
-- 2. review_list：按时间倒序的评论列表 = 有留言/回复的评价（抓取表）+ 空档占位（抓取截止日之后接口发现的新评价，没有内容）。

alter table public.review_texts add column if not exists imgs jsonb;
create index if not exists review_texts_at on public.review_texts (review_at desc);

create or replace function public.review_texts_upsert(p_rows jsonb)
returns int language sql set search_path = public as $$
  with x as (
    select * from jsonb_to_recordset(p_rows) as t(
      review_id text, shop_key text, product_id text, sku_id text, seller_sku text, star smallint, review_at timestamp,
      order_id text, content text, content_zh text, reply text, reply_zh text, img_count smallint, imgs jsonb)
  ), up as (
    insert into review_texts as r (review_id, shop_key, product_id, sku_id, seller_sku, star, review_at, order_id,
                                   content, content_zh, reply, reply_zh, img_count, imgs)
    select review_id, shop_key, product_id, sku_id, seller_sku, star, review_at, order_id,
           content, content_zh, reply, reply_zh, coalesce(img_count, 0), imgs from x
    on conflict (review_id) do update set
      star = excluded.star, review_at = excluded.review_at, seller_sku = coalesce(excluded.seller_sku, r.seller_sku),
      content = coalesce(excluded.content, r.content), content_zh = coalesce(excluded.content_zh, r.content_zh),
      reply = coalesce(excluded.reply, r.reply), reply_zh = coalesce(excluded.reply_zh, r.reply_zh),
      img_count = excluded.img_count, imgs = coalesce(excluded.imgs, r.imgs), updated_at = now()
    returning 1
  ) select count(*)::int from up;
$$;

-- p_stars：要看的星级（如 {1,2}）；空 = 全部
create or replace function public.review_list(p_shops text[], p_from date, p_to date, p_stars int[], p_q text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = public as $$
  with sh as (select shop_key, crawl_until from review_shops),
  t as (
    select 'text'::text kind, r.review_at ts, r.shop_key, r.product_id, coalesce(r.seller_sku, p.seller_sku) sku, r.star,
           r.content, r.content_zh, r.reply, r.reply_zh, r.order_id, r.img_count, r.imgs, null::jsonb counts, false init
    from review_texts r left join review_products p using (shop_key, product_id)
    where r.review_at >= p_from and r.review_at < p_to + 1
      and (p_shops is null or cardinality(p_shops) = 0 or r.shop_key = any (p_shops))
      and (p_stars is null or cardinality(p_stars) = 0 or r.star = any (p_stars))
      and (coalesce(p_q, '') = '' or r.product_id ilike '%' || p_q || '%' or coalesce(r.seller_sku, p.seller_sku, '') ilike '%' || p_q || '%')
  ),
  g as (  -- 空档占位：抓取截止日之后接口新增（正数）的评价，没有内容
    select 'gap'::text kind, (d + time '23:59:59') ts, d.shop_key, d.product_id, p.seller_sku sku, null::smallint star,
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
      and (coalesce(p_q, '') = '' or d.product_id ilike '%' || p_q || '%' or coalesce(p.seller_sku, '') ilike '%' || p_q || '%')
  ),
  g2 as (select * from g where (counts->>0)::int + (counts->>1)::int + (counts->>2)::int + (counts->>3)::int + (counts->>4)::int > 0),
  a as (select * from t union all select * from g2)
  select jsonb_build_object(
    'total', (select count(*) from a),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.ts desc) from (select * from a order by ts desc limit p_limit offset p_offset) x), '[]'::jsonb));
$$;
revoke all on function public.review_list(text[], date, date, int[], text, int, int), public.review_texts_upsert(jsonb) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
