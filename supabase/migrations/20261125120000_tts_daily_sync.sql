-- TikTok Shop 订单 / 财务结算 每日增量入库（负责人 2026-11-25 定：先按天更新，先 PH、TH 测试再逐店接入）。
-- 存接口原文（去掉空值与 0，体积小），口径映射放在汇总计算层（参考 yunge008/finance-order，只读）。
-- 写入方：Edge Function tts-export kind=sync（由 /api/public/hooks/tts-sync-cron 驱动）。只读消费：汇总页 / AI 只读通道。

alter table public.tts_shops add column if not exists daily_sync boolean not null default false;
update public.tts_shops set daily_sync = true where region in ('PH', 'TH');

-- 订单：一单一行，update_time 变了就整行覆盖
create table if not exists public.tts_orders (
  shop_id text not null,
  order_id text not null,
  status text,
  create_time timestamptz,
  update_time timestamptz,
  raw jsonb not null,            -- /order/202309/orders/search 返回的订单原文（去空值/0）
  returns jsonb,                 -- 该单退货退款（Search Returns，未拒绝未取消）：[{sku_id, qty, refund_total}]
  synced_at timestamptz not null default now(),
  primary key (shop_id, order_id)
);
create index if not exists tts_orders_shop_create on public.tts_orders (shop_id, create_time);

-- 结算单（= 后台「对账单」页签）
create table if not exists public.tts_finance_statements (
  shop_id text not null,
  statement_id text not null,
  statement_time timestamptz,
  currency text,
  raw jsonb not null,
  tx_count int,
  tx_synced_at timestamptz,      -- 交易明细已全部入库的时间；null = 待拉
  primary key (shop_id, statement_id)
);
create index if not exists tts_fin_stmt_time on public.tts_finance_statements (shop_id, statement_time);

-- 结算交易（= 后台「订单详情」页签，一行一笔交易，订单维度）
create table if not exists public.tts_finance_tx (
  shop_id text not null,
  tx_id text not null,
  statement_id text not null,
  statement_time timestamptz,
  tx_type text,
  order_id text,
  order_create_time timestamptz,
  raw jsonb not null,            -- statement_transactions 原文（去空值/0）
  synced_at timestamptz not null default now(),
  primary key (shop_id, tx_id)
);
create index if not exists tts_fin_tx_stmt on public.tts_finance_tx (shop_id, statement_id);
create index if not exists tts_fin_tx_order on public.tts_finance_tx (shop_id, order_id);

-- 同步进度与告警
create table if not exists public.tts_sync_state (
  shop_id text not null,
  kind text not null,            -- orders | finance
  watermark timestamptz,         -- 已完整同步到的时间点（orders=update_time，finance=statement_time）
  cursor jsonb,                  -- 未跑完的分片
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  unknown_fields jsonb not null default '{}'::jsonb, -- 接口出现、口径表未登记且非 0 的字段：{path: {first_seen, sample}}
  primary key (shop_id, kind)
);

alter table public.tts_orders enable row level security;
alter table public.tts_finance_statements enable row level security;
alter table public.tts_finance_tx enable row level security;
alter table public.tts_sync_state enable row level security;
revoke all on public.tts_orders, public.tts_finance_statements, public.tts_finance_tx, public.tts_sync_state from anon, authenticated;

-- 给 AI 只读通道授权新表（同一规则，敏感列名不授）
select public.ai_reader_refresh_grants();

-- 每小时第 17 分跑一次增量（首次回填 2026-08-01 起，分多轮续跑；回填完成后每轮只有几次接口调用）
do $$
declare
  url text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/tts-sync-cron';
begin
  if exists (select 1 from cron.job where jobname = 'tts-daily-sync') then
    perform cron.unschedule('tts-daily-sync');
  end if;
  perform cron.schedule('tts-daily-sync', '17 * * * *',
    format('select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret()), body := ''{}''::jsonb, timeout_milliseconds := 600000);', url));
end $$;
