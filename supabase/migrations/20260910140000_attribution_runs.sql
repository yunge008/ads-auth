-- 归因两层存储的第二层：归因结果快照（含历史）。
--   第一层 = ad_upload_agg（达人昵称 / VID 维度的原始数据，上传时归并）
--   第二层 = attribution_runs + attribution_run_rows（一次「全站点全人员」归因的结果快照）
-- 前台默认读某月最新一次 READY 快照，不再每次即时全量重算；每晚由 cron 刷新一次全部近月，
-- 也可以在页面上手动「立即重算」生成一条新快照。历史快照保留，可对比不同时点的归因结果。

CREATE TABLE IF NOT EXISTS public.attribution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL,
  -- CRON = 每晚自动刷新；MANUAL = 页面上点「立即重算」；UPLOAD = 上传完成后顺带刷新
  source text NOT NULL DEFAULT 'MANUAL',
  triggered_by text,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'READY', 'FAILED')),
  upload_count integer NOT NULL DEFAULT 0,
  agg_rows integer NOT NULL DEFAULT 0,
  raw_rows bigint NOT NULL DEFAULT 0,
  staff_count integer NOT NULL DEFAULT 0,
  total_gmv numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  total_orders bigint NOT NULL DEFAULT 0,
  -- 完整的 AttributionReport（前端进度板直接用这个渲染）
  summary jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

GRANT ALL ON public.attribution_runs TO service_role;
ALTER TABLE public.attribution_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only" ON public.attribution_runs;
CREATE POLICY "service role only" ON public.attribution_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS attribution_runs_month_idx ON public.attribution_runs(month, finished_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS attribution_runs_status_idx ON public.attribution_runs(status, started_at DESC);

-- 明细：一行 = 一个归并组在这次快照里的归因结果。下钻直接查这张表，不再重算。
CREATE TABLE IF NOT EXISTS public.attribution_run_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.attribution_runs(id) ON DELETE CASCADE,
  month text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  vid text NOT NULL DEFAULT '',
  account_name text NOT NULL DEFAULT '',
  product_id text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'USD',
  rows_count integer NOT NULL DEFAULT 0,
  -- 原币种金额
  cost numeric NOT NULL DEFAULT 0,
  gross_revenue numeric NOT NULL DEFAULT 0,
  orders bigint NOT NULL DEFAULT 0,
  -- 折美元后的金额（按快照生成时的汇率）
  cost_usd numeric NOT NULL DEFAULT 0,
  gmv_usd numeric NOT NULL DEFAULT 0,
  bucket text NOT NULL DEFAULT 'UNMATCHED',
  staff text,
  role text,
  match_type text,
  handover_applied boolean NOT NULL DEFAULT false,
  posted_at timestamptz,
  posted_at_source text
);

GRANT ALL ON public.attribution_run_rows TO service_role;
ALTER TABLE public.attribution_run_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only" ON public.attribution_run_rows;
CREATE POLICY "service role only" ON public.attribution_run_rows FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS attribution_run_rows_run_bucket_idx
  ON public.attribution_run_rows(run_id, bucket, gmv_usd DESC);
CREATE INDEX IF NOT EXISTS attribution_run_rows_run_staff_idx
  ON public.attribution_run_rows(run_id, staff, gmv_usd DESC);

-- 只保留每个月最近 _keep 次快照（默认 10），避免明细表无限增长。
CREATE OR REPLACE FUNCTION public.attribution_runs_prune(_month text, _keep integer DEFAULT 10)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  n integer;
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
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_runs_prune(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_runs_prune(text, integer) TO service_role;
