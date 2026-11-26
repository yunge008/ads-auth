-- 2026-11-26 归因快照：失败快照的候选分片也清掉（原有缺口）。
-- 背景：11-25 晚 23:30 的 08/09/10 三条快照卡在 RUNNING（cron 一次请求给 3 个月建分片超时，见 attribution-cron 1126.320 改为逐月），
-- 留下判定键 29 万行 + 候选分片 29 万行。attribution_runs_fail_stale 只改状态不清数据；候选分片表原来没有任何清理，
-- 失败快照的候选会一直留着。本 migration：prune 在清判定键的同时清已结束（READY/FAILED）快照的候选；
-- 存量：先把超过 10 分钟没进展的 RUNNING 标为 FAILED（与 fail_stale 同一规则），再清所有已结束快照的判定键与候选。
-- 不改任何归因结果（这两张表只在计算过程中读）。其余逻辑与 20261126150200 相同。
CREATE OR REPLACE FUNCTION public.attribution_runs_prune(_month text, _keep integer DEFAULT 10)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  n integer;
  _latest uuid;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (ORDER BY started_at DESC) AS rn
    FROM public.attribution_runs
    WHERE month = _month
  )
  DELETE FROM public.attribution_runs r
  USING ranked
  WHERE r.id = ranked.id AND ranked.rn > GREATEST(_keep, 1);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- 明细一个月只留最新一条快照的：几十万行 × 多条快照会把表撑爆，
  -- 历史快照保留 summary（数字对比够用），不保留可下钻的明细。
  SELECT id INTO _latest
  FROM public.attribution_runs
  WHERE month = _month AND status = 'READY'
  ORDER BY finished_at DESC NULLS LAST
  LIMIT 1;

  IF _latest IS NOT NULL THEN
    DELETE FROM public.attribution_run_rows d
    USING public.attribution_runs r
    WHERE d.run_id = r.id AND r.month = _month AND d.run_id <> _latest;

    DELETE FROM public.attribution_run_keys k
    USING public.attribution_runs r
    WHERE k.run_id = r.id AND r.month = _month AND k.run_id <> _latest;
  END IF;

  -- 2026-11-26：判定键、候选分片只在计算过程中用，已结束的快照（含最新一条）一律清掉
  DELETE FROM public.attribution_run_keys k
  USING public.attribution_runs r
  WHERE k.run_id = r.id AND r.month = _month AND r.status IN ('READY', 'FAILED');
  DELETE FROM public.attribution_run_candidates c
  USING public.attribution_runs r
  WHERE c.run_id = r.id AND r.month = _month AND r.status IN ('READY', 'FAILED');

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_runs_prune(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_runs_prune(text, integer) TO service_role;

SELECT public.attribution_runs_fail_stale(10);

DELETE FROM public.attribution_run_keys k
USING public.attribution_runs r
WHERE k.run_id = r.id AND r.status IN ('READY', 'FAILED');

DELETE FROM public.attribution_run_candidates c
USING public.attribution_runs r
WHERE c.run_id = r.id AND r.status IN ('READY', 'FAILED');
