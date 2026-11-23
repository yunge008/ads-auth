-- 快照重算「超 10 分钟被误标 FAILED」修复（2026-11-23）
-- 原 attribution_runs_fail_stale 按 started_at 判断：大月份分片判定整体超过 10 分钟时，仍在推进的 run 被标成 FAILED。
-- 改为按最后心跳 heartbeat_at（每判一片更新一次）判断「多久没动静」；没有心跳的老行退回 started_at。
ALTER TABLE public.attribution_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

CREATE OR REPLACE FUNCTION public.attribution_runs_fail_stale(_minutes integer DEFAULT 10)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  _n integer;
BEGIN
  UPDATE public.attribution_runs
  SET status = 'FAILED',
      error = coalesce(error, format('后台重算进程已中断（超过 %s 分钟没有进展）', _minutes)),
      finished_at = now()
  WHERE status = 'RUNNING'
    AND coalesce(heartbeat_at, started_at) < now() - make_interval(mins => _minutes);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;
REVOKE ALL ON FUNCTION public.attribution_runs_fail_stale(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_runs_fail_stale(integer) TO service_role;
