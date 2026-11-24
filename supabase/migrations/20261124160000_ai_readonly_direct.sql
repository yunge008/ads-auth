-- AI 只读查询通道 v2：直接经 PostgREST 调用，不依赖网站发布（负责人 2026-11-24 要求核验后台最新而非发布版本）。
-- 调用：POST {SUPABASE_URL}/rest/v1/rpc/ai_db_query，apikey = 公开 publishable key，请求头 x-ai-db-key = 「AI只读」账号口令。
-- 安全：
--   · ai_db_query 由 ai_reader 角色拥有（SECURITY DEFINER = 以 ai_reader 身份执行），不给 anon 任何角色成员关系；
--     ai_reader 只有按列 SELECT（敏感列名不授，见 20261124150000），外加只读事务。
--   · 口令校验 ai_key_ok()：请求头 sha256 = app_accounts 中 name='AI只读'、非管理员、启用中账号的 passcode_hash；不对就报错。
--   · 停用/删除「AI只读」账号即撤销。
-- 取代 20261124150000 的服务端路由方案（该路由已删除，旧函数 ai_readonly_query 一并删除）。

grant ai_reader to current_user;
grant create on schema public to ai_reader; -- 拥有函数所需；实际执行在只读事务里，无法建对象

create or replace function public.ai_key_ok()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with k as (
    select coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-ai-db-key', '') as v
  )
  select exists (
    select 1
    from public.app_accounts a, k
    where k.v <> ''
      and a.name = 'AI只读'
      and a.active
      and not a.is_admin
      and a.passcode_hash = encode(sha256(convert_to(k.v, 'UTF8')), 'hex')
  );
$$;

revoke all on function public.ai_key_ok() from public, anon, authenticated;
grant execute on function public.ai_key_ok() to ai_reader;

create or replace function public.ai_db_query(q text, max_rows int default 2000)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  s text := regexp_replace(btrim(coalesce(q, '')), ';\s*$', '');
  res jsonb;
begin
  if not public.ai_key_ok() then
    raise exception '未授权' using errcode = '42501';
  end if;
  if s !~* '^(select|with)\s' then
    raise exception '只允许 SELECT / WITH 查询';
  end if;
  set transaction read only;
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit %s) t',
    s, least(greatest(coalesce(max_rows, 2000), 1), 2000)
  ) into res;
  return res;
end;
$$;

alter function public.ai_db_query(text, int) owner to ai_reader;
revoke all on function public.ai_db_query(text, int) from public;
grant execute on function public.ai_db_query(text, int) to anon, authenticated, service_role;

-- 新增表后补授列权限（同一规则），同样要口令
create or replace function public.ai_db_refresh_grants()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.ai_key_ok() then
    raise exception '未授权' using errcode = '42501';
  end if;
  return public.ai_reader_refresh_grants();
end;
$$;

revoke all on function public.ai_db_refresh_grants() from public;
grant execute on function public.ai_db_refresh_grants() to anon, authenticated, service_role;

drop function if exists public.ai_readonly_query(text, int);

notify pgrst, 'reload schema';
