-- GMV MAX 素材数据自动抓取（归因用）阶段 A：接口取数落库 + 与上传表对账。
-- 三张新表，全部独立于 ad_uploads / ad_upload_agg：归因引擎只读 ad_uploads.status='READY'，
-- 这里的数据在「对账全部一致、负责人确认切换」之前不会进入任何归因计算。
-- 只存 花费/GMV/订单 任一非 0 的行（全 0 行只计数，存进 batch.fields），控制容量。

create table if not exists public.gmv_max_material_batches (
  id uuid primary key default gen_random_uuid(),
  country text not null,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'READY', 'FAILED')),
  triggered_by text,
  -- 每个广告户的抓取进度与结果：[{advertiser_id, name, active, status, error, pending_campaigns, campaign_totals, rows, zero_rows}]
  advertisers jsonb not null default '[]'::jsonb,
  -- 字段清单：接口实际返回的 metric、内容类型取值、币种、未识别值 —— 字段变化不许悄悄处理，全部在这里显式列出
  fields jsonb not null default '{}'::jsonb,
  -- 对账报告（reconcile 动作写入）
  report jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  reconciled_at timestamptz
);
create index if not exists gmv_max_material_batches_cm on public.gmv_max_material_batches (country, month, started_at desc);

create table if not exists public.gmv_max_material_agg (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.gmv_max_material_batches(id) on delete cascade,
  advertiser_id text not null,
  campaign_id text not null,
  product_id text not null,            -- 接口 item_group_id（= 上传表「商品 ID / SPU ID」，待对账核验）
  item_id text not null,               -- 接口 item_id 原值（视频为 VID；商品卡/直播的取值待对账确认）
  content_type_raw text,               -- 接口 shop_content_type 原值
  creative_type text not null,         -- 归一化：video | product_card | live | 原值（与 adExcel.normCreativeType 同规则）
  account_name text,                   -- 接口 tt_account_name 原值
  title text,
  posted_raw text,                     -- 接口发布时间原值（字段名见 batch.fields.posted_field）
  currency text,
  cost numeric not null default 0,
  gross_revenue numeric not null default 0,
  orders integer not null default 0,
  impressions bigint,
  clicks bigint,
  unique (batch_id, advertiser_id, campaign_id, product_id, item_id)
);
create index if not exists gmv_max_material_agg_batch on public.gmv_max_material_agg (batch_id);

-- 站点 × 广告户 × 天 的消耗（换户检测用；体量极小）
create table if not exists public.gmv_max_adv_daily (
  advertiser_id text not null,
  stat_date date not null,
  country text not null,
  cost numeric not null default 0,
  gross_revenue numeric not null default 0,
  orders integer not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (advertiser_id, stat_date)
);
create index if not exists gmv_max_adv_daily_cd on public.gmv_max_adv_daily (country, stat_date);

alter table public.gmv_max_material_batches enable row level security;
alter table public.gmv_max_material_agg enable row level security;
alter table public.gmv_max_adv_daily enable row level security;
-- 不建任何 policy：只有 service_role（服务端路由）能读写；AI 只读通道靠下面刷新授权。

select public.ai_reader_refresh_grants();
