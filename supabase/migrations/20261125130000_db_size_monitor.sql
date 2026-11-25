-- 数据库空间监控（负责人 2026-11-25：订单明细永久保存，空间到 80% 再提示处理）。
-- 只读：返回当前数据库字节数，仅 service_role（服务端路由 tts-sync-cron）可调用。
create or replace function public.db_size_bytes()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog
as $$ select pg_database_size(current_database()) $$;

revoke all on function public.db_size_bytes() from public, anon, authenticated;
grant execute on function public.db_size_bytes() to service_role;
