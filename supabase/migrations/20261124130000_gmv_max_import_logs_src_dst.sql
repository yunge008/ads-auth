-- 导入记录补来源/去向的广告户名与 BC（账户复制有来源户；Excel/单条只有去向）
alter table public.gmv_max_import_logs
  add column if not exists source_advertiser_id text not null default '',
  add column if not exists source_advertiser_name text not null default '',
  add column if not exists source_bc_id text not null default '',
  add column if not exists source_bc_name text not null default '',
  add column if not exists advertiser_name text not null default '',
  add column if not exists bc_name text not null default '';
