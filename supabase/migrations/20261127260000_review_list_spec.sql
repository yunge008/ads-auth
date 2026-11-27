-- 评论查看：评论内容 SKU 列（负责人 2026-11-27 截图：SKU 列被「108, Gift bag x 1」这类长文本撑宽）
-- 原 sku = coalesce(评价上的 SKU 规格, 链接卖家 SKU)；SKU 规格是买家下单的款式描述，不是卖家 SKU。
-- 改为 sku = 链接卖家 SKU（没有才用 SKU 规格），另返回 spec = SKU 规格（页面悬停显示）。

drop function if exists public.review_list(text[], date, date, int[], text, int, int, text, boolean, boolean);
create or replace function public.review_list(p_shops text[], p_from date, p_to date, p_stars int[], p_q text,
                                              p_limit int, p_offset int, p_sort text default 'ts', p_desc boolean default true,
                                              p_only boolean default false)
returns jsonb language sql stable set search_path = public as $$
  with t as (
    select 'text'::text kind, r.review_id, r.review_at ts, r.shop_key, r.product_id, coalesce(p.seller_sku, r.seller_sku) sku, r.seller_sku spec, p.title,
           r.star::int star, 1 cnt, false init, r.content, r.content_zh, r.reply, r.reply_zh, r.order_id, r.img_count::int img_count, r.imgs
    from review_texts r left join review_products p using (shop_key, product_id)
    where r.review_at >= p_from and r.review_at < p_to + 1
      and (not p_only or coalesce(r.content, '') <> '' or jsonb_array_length(coalesce(r.imgs, '[]'::jsonb)) > 0)
      and (p_shops is null or cardinality(p_shops) = 0 or r.shop_key = any (p_shops))
      and (p_stars is null or cardinality(p_stars) = 0 or r.star = any (p_stars))
      and (coalesce(p_q, '') = '' or r.product_id ilike '%' || p_q || '%' or coalesce(r.seller_sku, p.seller_sku, '') ilike '%' || p_q || '%'
           or coalesce(p.title, '') ilike '%' || p_q || '%')
  ),
  g as (
    select 'gap'::text kind, null::text review_id, (d.d + time '23:59:59') ts, d.shop_key, d.product_id, p.seller_sku sku, null::text spec, p.title,
           s.star, s.cnt, d.source = 'api_init' init, null::text content, null::text content_zh, null::text reply, null::text reply_zh,
           null::text order_id, 0 img_count, null::jsonb imgs
    from review_daily d
    join review_products p using (shop_key, product_id)
    left join review_shops sh using (shop_key)
    cross join lateral (values (1, d.s1), (2, d.s2), (3, d.s3), (4, d.s4), (5, d.s5)) as s(star, cnt)
    where not p_only and d.source in ('api', 'api_init') and d.d > coalesce(sh.crawl_until, date '1900-01-01')
      and d.d >= p_from and d.d <= p_to and s.cnt > 0
      and (p_shops is null or cardinality(p_shops) = 0 or d.shop_key = any (p_shops))
      and (p_stars is null or cardinality(p_stars) = 0 or s.star = any (p_stars))
      and (coalesce(p_q, '') = '' or d.product_id ilike '%' || p_q || '%' or coalesce(p.seller_sku, '') ilike '%' || p_q || '%'
           or coalesce(p.title, '') ilike '%' || p_q || '%')
  ),
  a as (select * from t union all select * from g)
  select jsonb_build_object(
    'total', (select count(*) from a),
    'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select * from a
      order by
        case when p_sort = 'sku' and not p_desc then sku end asc nulls last,
        case when p_sort = 'sku' and p_desc then sku end desc nulls last,
        case when p_sort = 'star' and not p_desc then star end asc,
        case when p_sort = 'star' and p_desc then star end desc,
        case when not p_desc and p_sort = 'ts' then ts end asc,
        ts desc
      limit p_limit offset p_offset) x), '[]'::jsonb));
$$;

revoke all on function public.review_list(text[], date, date, int[], text, int, int, text, boolean, boolean) from public, anon, authenticated;

select public.ai_reader_refresh_grants();
