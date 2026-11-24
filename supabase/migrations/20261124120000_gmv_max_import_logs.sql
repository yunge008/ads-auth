-- GMV Max 导入记录：每次「Excel 批量新建」/「从账户复制」逐商品一行，记录导入结果。
-- 只由服务端路由 /api/public/hooks/gmv-max-write 用 service role 读写；开启 RLS 且不建任何策略 → anon/authenticated 无权访问。
create table if not exists public.gmv_max_import_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  batch_id text not null,
  kind text not null default 'excel',          -- excel | copy | single
  source text not null default '',             -- 文件名 / 源广告户
  operator text not null default '',
  advertiser_id text not null default '',
  bc_id text not null default '',
  campaign_name text not null default '',
  source_campaign_id text not null default '',
  new_campaign_id text,
  group_status text not null default '',       -- 成功 | 已建·需处理 | 失败
  group_note text not null default '',
  item_group_id text not null default '',
  status text not null default '',             -- 成功 | 失败 | 组成功商品未纳入
  reason text not null default ''
);
create index if not exists gmv_max_import_logs_batch_idx on public.gmv_max_import_logs (batch_id);
create index if not exists gmv_max_import_logs_created_idx on public.gmv_max_import_logs (created_at desc);
alter table public.gmv_max_import_logs enable row level security;
