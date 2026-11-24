-- AI 只读查询通道（负责人 2026-11-24 同意）
-- 角色 ai_reader：只按列授予 SELECT，列名含 token/secret/passcode/password/cookie/credential/api_key/app_key/device_id 的列一律不授；
-- 查询函数 ai_readonly_query：只接受 SELECT/WITH，切到 ai_reader + 只读事务 + 最多 2000 行。
-- 注意：函数内设 statement_timeout 对当前语句不生效（本地 PG16 实测），超时只能靠平台默认值，查询需自行控制规模。
-- 只有 service_role（服务端路由 /api/public/hooks/ai-db-read）能调用；anon / authenticated 无执行权限。
-- 以后新增表：路由 action=refresh_grants 重新按同一规则授权，无需再跑 SQL。

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_reader') then
    create role ai_reader nologin;
  end if;
end $$;

grant usage on schema public to ai_reader;
grant ai_reader to service_role;

create or replace function public.ai_reader_refresh_grants()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  r record;
  n_cols int := 0;
  n_pol int := 0;
  skipped text[] := '{}';
  errors text[] := '{}';
begin
  for r in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
  loop
    begin
      if r.column_name ~* '(token|secret|passcode|password|cookie|credential|api_key|app_key|device_id)' then
        execute format('revoke select (%I) on public.%I from ai_reader', r.column_name, r.table_name);
        skipped := skipped || (r.table_name || '.' || r.column_name);
      else
        execute format('grant select (%I) on public.%I to ai_reader', r.column_name, r.table_name);
        n_cols := n_cols + 1;
      end if;
    exception when others then
      errors := errors || (r.table_name || '.' || r.column_name || ': ' || sqlerrm);
    end;
  end loop;

  -- 开了 RLS 的表：给 ai_reader 一条只读放行策略（列权限仍受上面限制）
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'ai_reader_select')
  loop
    begin
      execute format('create policy ai_reader_select on public.%I for select to ai_reader using (true)', r.relname);
      n_pol := n_pol + 1;
    exception when others then
      errors := errors || (r.relname || ' policy: ' || sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'granted_columns', n_cols,
    'new_policies', n_pol,
    'skipped_columns', to_jsonb(skipped),
    'errors', to_jsonb(errors)
  );
end;
$$;

create or replace function public.ai_readonly_query(q text, max_rows int default 2000)
returns jsonb
language plpgsql
security invoker
as $$
declare
  s text := regexp_replace(btrim(coalesce(q, '')), ';\s*$', '');
  res jsonb;
begin
  if s !~* '^(select|with)\s' then
    raise exception '只允许 SELECT / WITH 查询';
  end if;
  set transaction read only;
  set local role ai_reader;
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit %s) t',
    s, least(greatest(coalesce(max_rows, 2000), 1), 2000)
  ) into res;
  return res;
end;
$$;

revoke all on function public.ai_reader_refresh_grants() from public, anon, authenticated;
revoke all on function public.ai_readonly_query(text, int) from public, anon, authenticated;
grant execute on function public.ai_reader_refresh_grants() to service_role;
grant execute on function public.ai_readonly_query(text, int) to service_role;

select public.ai_reader_refresh_grants();
