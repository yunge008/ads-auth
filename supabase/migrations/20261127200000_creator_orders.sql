-- 达人出单日报（docs/CREATOR_ORDERS_PLAN.md，1127.338）
-- 数据：GMV Max 报表 素材 × 商品 × 天（广告户时区自然日），每小时由服务端路由 creator-orders-cron 刷新今天及前两天。
-- 存储（负责人 2026-11-27：保留不设上限，库容到 80% 再考虑删旧数据）：
--   co_daily 只存「花费/订单/GMV 任一非 0」的行；ID 用 bigint、金额用整数「分」，文本不进日表；
--   达人名、昵称、账号类型放 co_vid（每 VID 一行）。
-- 只给服务端路由（service role）读写；RLS 开、无策略。AI 只读通道需另跑 select public.ai_db_refresh_grants();

create table if not exists public.co_daily (
  stat_date date not null,
  advertiser_id bigint not null,
  vid bigint not null,            -- 商品卡 item_id = -1
  spu bigint not null,            -- item_group_id
  country text not null,
  cost_c integer not null default 0,   -- 花费（分，广告户币种，当前全部为 USD）
  gmv_c integer not null default 0,    -- GMV（分）
  orders integer not null default 0,   -- SKU 订单数（含自然流量）
  imps integer not null default 0,     -- 商品广告曝光
  clicks integer not null default 0,   -- 商品广告点击
  primary key (stat_date, advertiser_id, vid, spu)
);
create index if not exists co_daily_country_date on public.co_daily (country, stat_date);
alter table public.co_daily enable row level security;

create table if not exists public.co_vid (
  vid bigint primary key,
  country text,
  handle text,          -- TikTok 用户名
  nickname text,        -- 昵称（只有视频列表接口给，可能为空）
  author_type text,     -- OFFICIAL_ACCOUNTS / MARKETING_ACCOUNTS / AFFILIATE_ACCOUNTS
  posted_local text,    -- 发布时间（接口原样，站点当地时间）
  checked_at timestamptz -- 最近一次查接口的时间（查不到也记，避免反复查）
);
alter table public.co_vid enable row level security;

create table if not exists public.co_state (
  advertiser_id bigint primary key,
  country text,
  advertiser_name text,
  currency text,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_rows integer,
  last_error text
);
alter table public.co_state enable row level security;

create table if not exists public.co_settings (
  id integer primary key default 1 check (id = 1),
  t_vid integer not null default 10,     -- 单素材单日订单 ≥ 标爆单
  t_cr integer not null default 20,      -- 单达人单日订单 ≥ 标爆单
  own_kw text not null default 'artphro',-- 账号名含此关键词视为官号
  updated_at timestamptz default now()
);
insert into public.co_settings (id) values (1) on conflict (id) do nothing;
alter table public.co_settings enable row level security;

-- 区间汇总：按 站点 × 素材 × 商品 聚合，并带逐日 [订单, GMV分, 花费分]（只含非 0 的日子），供页面分组与走势
create or replace function public.co_query(p_start date, p_end date, p_countries text[])
returns table (
  country text, vid text, spu text,  -- 19 位 ID 以文本返回，避免 JS 精度丢失
  cost_c bigint, gmv_c bigint, orders bigint, imps bigint, clicks bigint,
  days jsonb
)
language sql stable
set search_path = public
as $$
  select d.country, d.vid::text, d.spu::text,
         sum(d.cost_c), sum(d.gmv_c), sum(d.orders), sum(d.imps), sum(d.clicks),
         jsonb_object_agg(d.stat_date::text, jsonb_build_array(d.o, d.g, d.c))
  from (
    select country, vid, spu, stat_date,
           sum(cost_c) as cost_c, sum(gmv_c) as gmv_c, sum(orders) as orders, sum(imps) as imps, sum(clicks) as clicks,
           sum(orders) as o, sum(gmv_c) as g, sum(cost_c) as c
    from public.co_daily
    where stat_date between p_start and p_end
      and (p_countries is null or country = any(p_countries))
    group by country, vid, spu, stat_date
  ) d
  group by d.country, d.vid, d.spu
$$;
revoke all on function public.co_query(date, date, text[]) from public, anon, authenticated;
grant execute on function public.co_query(date, date, text[]) to service_role;

-- 每小时第 23 分刷新（避开 tts-daily-sync 第 17 分、reviews 第 35 分）
do $$
declare
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/creator-orders-cron';
begin
  if exists (select 1 from cron.job where jobname = 'creator-orders-hourly') then
    perform cron.unschedule('creator-orders-hourly');
  end if;
  perform cron.schedule('creator-orders-hourly', '23 * * * *',
    format('select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{}''::jsonb, timeout_milliseconds := 600000);', url));
end $$;
