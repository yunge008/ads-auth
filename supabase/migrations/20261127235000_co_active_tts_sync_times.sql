-- 1127.350 负责人 2026-11-27（时间均按新加坡时间）
-- ① 达人出单只查「当天启用」的广告户：co_adv_active 记 新加坡日期 × 广告户。
--    写入：定时/手动每轮第一步把此刻 advertiser_countries.active = true 的户记到今天；
--          设置里把户停用时，触发器把停用当天也记上（如前天启用、昨天切户停用 → 回看前天、昨天仍会查它）。
-- ② 订单/财务入库（tts-daily-sync）由每小时改为每天 3 次，分别在 07:00、14:00、20:00 前完成：
--    每个时段跑两次（第二次续跑第一次没跑完的部分），每次最长 8 分钟。
--    新加坡 06:40/06:52、13:40/13:52、19:40/19:52 = UTC 22:40/22:52、05:40/05:52、11:40/11:52。

create table if not exists public.co_adv_active (
  d date not null,             -- 新加坡日期
  advertiser_id text not null,
  primary key (d, advertiser_id)
);
alter table public.co_adv_active enable row level security;

create or replace function public.co_mark_deactivated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.active, false) and not coalesce(new.active, false) then
    insert into public.co_adv_active (d, advertiser_id)
    values ((now() at time zone 'Asia/Singapore')::date, old.advertiser_id)
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists co_mark_deactivated on public.advertiser_countries;
create trigger co_mark_deactivated
  after update of active on public.advertiser_countries
  for each row execute function public.co_mark_deactivated();

-- 初始数据：已抓到过数据的 户×天；当前启用户记近 3 天；近 3 天内被改过的停用户记改动当天（可能多查几个旧户，只多几次调用，不丢数据）
insert into public.co_adv_active (d, advertiser_id)
select distinct stat_date, advertiser_id::text from public.co_daily
on conflict do nothing;
insert into public.co_adv_active (d, advertiser_id)
select (now() at time zone 'Asia/Singapore')::date - g, advertiser_id
from public.advertiser_countries, generate_series(0, 2) g
where active
on conflict do nothing;
insert into public.co_adv_active (d, advertiser_id)
select (updated_at at time zone 'Asia/Singapore')::date, advertiser_id
from public.advertiser_countries
where not coalesce(active, false) and updated_at >= now() - interval '3 days'
on conflict do nothing;

do $$
declare
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/tts-sync-cron';
begin
  if exists (select 1 from cron.job where jobname = 'tts-daily-sync') then
    perform cron.unschedule('tts-daily-sync');
  end if;
  perform cron.schedule('tts-daily-sync', '40,52 22,5,11 * * *',
    format('select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{}''::jsonb, timeout_milliseconds := 600000);', url));
end $$;

-- AI 只读通道补授权（新表）
select public.ai_reader_refresh_grants();
