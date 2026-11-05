-- 联盟达人外联 P0：TikTok Shop 店铺授权表（Shop Open API，与广告线 tiktok_connections 无关）。
-- 一次授权（一个卖家账号）可能对应多个店铺：跨境卖家 PH/TH 各一行，shop_cipher 不同；token 相同，冗余存每行。
-- 只允许 service role 读写（开 RLS、不建 policy），前端不直接读 token。
create table if not exists public.tts_shops (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null unique,
  shop_cipher text not null,
  shop_code text,
  shop_name text,
  region text,
  seller_type text,                 -- CROSS_BORDER / LOCAL（Get Authorized Shops 原值）
  seller_name text,
  seller_base_region text,
  authorizer_open_id text,          -- token 接口返回的 open_id（授权的卖家账号）
  user_type int,
  access_token text not null,
  refresh_token text not null,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  scopes text[] not null default '{}',
  contact_info jsonb,               -- 定向计划 seller_contact_info，管理员配置（R10）
  status text not null default 'ACTIVE',
  authorized_by text,               -- 操作人账号名
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tts_shops enable row level security;

create index if not exists tts_shops_region_idx on public.tts_shops (region);
