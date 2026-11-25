-- 2026-11-26 归因快照「判定键」用完即删（低风险，不改任何归因数字）。
-- attribution_run_keys 只在生成快照的过程中使用（seed_run_keys → write_run_keys → apply_run 生成 attribution_run_rows），
-- 快照 READY 后再没有任何函数/页面读取它（2026-11-26 查库内函数与 supabase/functions、src 全部引用确认）。
-- 现状：5 个月 × 每月一份，共约 78 万行 / 270 MB，每月新增约 14–25 万行。
-- 变更：attribution_runs_prune（快照完成时调用）在保留最新快照明细的同时，删除该月所有「已结束（READY/FAILED）」快照的判定键；
-- 正在计算中的快照（RUNNING）不动。其余逻辑与 20260911120000 原定义逐行相同。
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

  -- 2026-11-26：判定键只在计算过程中用，已结束的快照（含最新一条）一律清掉
  DELETE FROM public.attribution_run_keys k
  USING public.attribution_runs r
  WHERE k.run_id = r.id AND r.month = _month AND r.status IN ('READY', 'FAILED');

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_runs_prune(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_runs_prune(text, integer) TO service_role;

-- 存量：已结束快照的判定键一次清掉（RUNNING 不动）。键所在表没有其他引用，删后用 VACUUM FULL 还空间（见 WORKLOG）。
DELETE FROM public.attribution_run_keys k
USING public.attribution_runs r
WHERE k.run_id = r.id AND r.status IN ('READY', 'FAILED');
