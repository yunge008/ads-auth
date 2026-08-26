-- 发样及素材统计：BD 建联表 + 剪辑登记表的只读缓存表。
-- 只从飞书读入，不回写飞书；每次同步按 source_sheet 先删后插。
create table public.connection_material_registry (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('BD','EDITOR')),
  source_sheet text not null,
  row_number integer,
  staff_name text not null,
  staff_active boolean not null default true,
  country text not null default '',
  handle text not null default '',       -- BD:达人用户名(D) / EDITOR:账号(E)
  sku text,
  fan_count numeric,                     -- BD only，F 列，单位=K（千）
  gmv_usd numeric,                       -- BD only，H 列，预留未使用
  sample_date date,                      -- BD only，B 列发样日期
  register_date date,                    -- BD only，N 列视频登记日期（BD 回收有效日期）
  post_date date,                        -- BD:O 列视频发布日期(预留) / EDITOR:C 列日期（回收有效日期）
  vid text not null default '',
  auth_code text,                        -- BD only，Q 列，预留未使用
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

grant all on public.connection_material_registry to service_role;
alter table public.connection_material_registry enable row level security;
create policy "service role only" on public.connection_material_registry
  for all to service_role using (true) with check (true);

create index connection_material_registry_source_idx on public.connection_material_registry(source_type);
create index connection_material_registry_country_idx on public.connection_material_registry(country);
create index connection_material_registry_staff_idx on public.connection_material_registry(staff_name);
create index connection_material_registry_vid_idx on public.connection_material_registry(vid);
create index connection_material_registry_sheet_idx on public.connection_material_registry(source_sheet);
create index connection_material_registry_sample_date_idx on public.connection_material_registry(sample_date);
create index connection_material_registry_register_date_idx on public.connection_material_registry(register_date);
create index connection_material_registry_post_date_idx on public.connection_material_registry(post_date);
