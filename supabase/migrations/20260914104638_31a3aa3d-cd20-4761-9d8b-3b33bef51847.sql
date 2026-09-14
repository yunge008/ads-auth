-- 快照重算超时的根因不是 SQL 慢，是**请求次数太多**。
--
-- PostgREST 单次最多返回 1000 行，判定键有 16 万+，于是读键要来回 168 次 HTTP；
-- 判定结果按 2000 行一批写回，又是 84 次。250 多次往返串行跑下来轻松过分钟级，
-- 而 Edge Function 的后台任务有墙钟上限，跑不完就被掐断——
-- 掐断时 attribution_runs 那行还停在 RUNNING，前端轮询永远等不到 READY/FAILED，
-- 最后只能报「快照重算超时」。
--
-- 这里用项目里已有的办法绕开行数上限：**返回一整个 JSON，就是一行**。
-- 读键一次两万、写键一次两万，往返次数从 250+ 降到 20 上下。

-- 读判定键：返回 JSON 数组（单行），不受 1000 行上限约束。
-- 排序与 attribution_month_keys 保持一致，分页才稳定。
CREATE OR REPLACE FUNCTION public.attribution_month_keys_json(
  _month text, _limit integer DEFAULT 20000, _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  FROM (
    SELECT a.country, a.vid, a.account_name, a.creative_type, min(a.posted_at) AS posted_at
    FROM public.ad_upload_agg a
    JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
    WHERE a.month = _month
    GROUP BY a.country, a.vid, a.account_name, a.creative_type
    ORDER BY a.country, a.vid, a.account_name, a.creative_type
    LIMIT _limit OFFSET _offset
  ) t;
$$;

REVOKE ALL ON FUNCTION public.attribution_month_keys_json(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_month_keys_json(text, integer, integer) TO service_role;

-- 写判定结果：一次收一个 JSON 数组，替代「2000 行一批 insert」。
CREATE OR REPLACE FUNCTION public.attribution_write_run_keys(_run_id uuid, _rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  _n integer;
BEGIN
  INSERT INTO public.attribution_run_keys (
    run_id, country, vid, account_name, creative_type,
    bucket, staff, role, match_type, handover_applied
  )
  SELECT
    _run_id,
    coalesce(r.country, ''),
    coalesce(r.vid, ''),
    coalesce(r.account_name, ''),
    coalesce(r.creative_type, ''),
    coalesce(r.bucket, 'UNMATCHED'),
    r.staff,
    r.role,
    r.match_type,
    coalesce(r.handover_applied, false)
  FROM jsonb_to_recordset(_rows) AS r(
    country text, vid text, account_name text, creative_type text,
    bucket text, staff text, role text, match_type text, handover_applied boolean
  );
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_write_run_keys(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_write_run_keys(uuid, jsonb) TO service_role;

-- 收尸：后台任务被墙钟掐断时，快照行会永远停在 RUNNING，前端只能干等到超时。
-- Edge Function 的后台任务上限是几分钟量级，所以 RUNNING 超过 _minutes 分钟的一定已经死了，
-- 直接标成 FAILED 并写明原因，轮询就能立刻拿到结论而不是等满 20 分钟。
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
      error = coalesce(error, format('后台重算进程已中断（RUNNING 超过 %s 分钟未完成）', _minutes)),
      finished_at = now()
  WHERE status = 'RUNNING'
    AND started_at < now() - make_interval(mins => _minutes);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_runs_fail_stale(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_runs_fail_stale(integer) TO service_role;