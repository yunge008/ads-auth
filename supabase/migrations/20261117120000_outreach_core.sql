-- 达人外联 A 线核心表（规则：docs/CREATOR_OWNERSHIP_RULES.md v1.2）
-- 与 GMV 归因引擎的 creator_registry / creator_ownership 完全独立，不改归因数字。
-- 全部开 RLS、不建 policy：只允许 Edge Function 用 service role 读写。

-- 参数（规则里的天数阈值都可配置，§0.3）
create table if not exists public.outreach_settings (
  key text primary key,
  value jsonb not null,
  note text,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.outreach_settings (key, value, note) values
  ('cooldown_days', '14', '§2 同站点池同达人联盟渠道两次触达最少间隔（天）'),
  ('protect_days', '90', '§3.3 保护期（含第 N 天）'),
  ('unreplied_tag_days', '90', '§8.1 未回复标签在最近一次触达满 N 天后消失'),
  ('max_msgs_before_reply', '2', 'R4 达人回复前最多消息条数')
on conflict (key) do nothing;

-- 触达记录（系统群发 / 系统定向 / 插件群发 / 人工跟进 / 外部渠道登记），一条消息一行
create table if not exists public.outreach_touches (
  id uuid primary key default gen_random_uuid(),
  site_pool text not null,
  shop_id text,
  creator_key text not null,           -- open_id 优先，否则归一化用户名
  creator_open_id text,
  username text,
  nickname text,
  bd text not null,                    -- 登录账号名
  channel text not null check (channel in ('affiliate', 'external')),
  kind text not null,                  -- im_bulk / tc_invite / plugin_bulk / im_manual / ai_reply / external
  source text not null default 'system' check (source in ('system', 'plugin')),
  touched_at timestamptz not null,
  touch_date date not null,            -- 北京时间自然日
  batch_id text,
  conversation_id text,
  tc_id text,
  message_type text,
  content text,
  result text not null default 'sent' check (result in ('sent', 'failed', 'blocked')),
  reason text,
  message_id text,
  client_ref text,                     -- 插件/系统侧去重键（同一条重复回传不重复入库）
  created_at timestamptz not null default now()
);
create index if not exists outreach_touches_creator on public.outreach_touches (site_pool, creator_key, touched_at desc);
create unique index if not exists outreach_touches_client_ref on public.outreach_touches (client_ref);
alter table public.outreach_touches enable row level security;

-- 建联成功与续期事件：回复 / 申样批准 / 发样 / 回收 VID / 外部渠道建联
create table if not exists public.outreach_creator_events (
  id uuid primary key default gen_random_uuid(),
  site_pool text not null,
  shop_id text,
  creator_key text not null,
  creator_open_id text,
  username text,
  event text not null check (event in ('reply', 'sample_approved', 'sample_shipped', 'vid_recovered', 'external_success')),
  event_at timestamptz not null,
  event_date date not null,
  bd text,                             -- 回复为空时按 §3.5 推断
  ref text not null,                   -- 消息 ID / 申样单 ID / VID / 外部登记 ID
  source text not null,                -- tts_im / tts_sample / feishu / plugin / manual
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (event, ref)
);
create index if not exists outreach_events_creator on public.outreach_creator_events (site_pool, creator_key, event_at);
alter table public.outreach_creator_events enable row level security;

-- 冲突待判（§5），系统只提示，负责人判定
create table if not exists public.outreach_conflicts (
  id uuid primary key default gen_random_uuid(),
  site_pool text not null,
  creator_key text not null,
  username text,
  type text not null,
  bds text[] not null,
  detail text,
  found_date date not null,
  status text not null default 'open' check (status in ('open', 'decided')),
  decision text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (site_pool, creator_key, type, found_date)
);
alter table public.outreach_conflicts enable row level security;

-- 达人归属状态快照（每晚 + 事件后重算），供标签、插件、每日清单读取
create table if not exists public.outreach_creator_state (
  site_pool text not null,
  creator_key text not null,
  creator_open_id text,
  username text,
  nickname text,
  owner_bd text,
  protect_until date,
  anchor_date date,
  anchor_type text,
  last_touch_bd text,
  last_touch_date date,
  cooldown_until date,
  tag text not null default '',
  computed_for date not null,
  updated_at timestamptz not null default now(),
  primary key (site_pool, creator_key)
);
create index if not exists outreach_state_username on public.outreach_creator_state (site_pool, username);
alter table public.outreach_creator_state enable row level security;
