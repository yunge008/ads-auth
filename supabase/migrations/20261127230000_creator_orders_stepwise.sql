-- 达人出单日报：定时同步改为分步（1127.340）
-- 原因：Lovable 服务端单次请求时长有限（11-27 首次手动刷新约 20 秒后中断，只处理了 2 个广告户）。
-- 改为每 5 分钟调一次，每次 ≤25 秒，游标记在 co_settings；每个整点开始新一轮（先逐户同步，再补达人名）。
alter table public.co_settings
  add column if not exists sync_cursor integer,          -- 下一个要同步的广告户序号；null = 本轮同步已完成
  add column if not exists names_cursor integer,         -- 下一个要补名的站点序号；null = 已完成
  add column if not exists cycle_started_at timestamptz, -- 本轮开始时间（每小时最多开一轮）
  add column if not exists sync_tries integer not null default 0; -- 同一步已尝试次数（≥2 次未完成则跳过这一步）

do $$
declare
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/creator-orders-cron';
begin
  if exists (select 1 from cron.job where jobname = 'creator-orders-hourly') then
    perform cron.unschedule('creator-orders-hourly');
  end if;
  if exists (select 1 from cron.job where jobname = 'creator-orders-step') then
    perform cron.unschedule('creator-orders-step');
  end if;
  perform cron.schedule('creator-orders-step', '*/5 * * * *',
    format('select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{}''::jsonb, timeout_milliseconds := 60000);', url));
end $$;
