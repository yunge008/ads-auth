-- 「无建联达人 TOP」按站点分开统计。
--
-- 原来是 GROUP BY lower(btrim(account_name))，**没有带站点**：
-- PH 的「Eagle」和 MX-AR 的「Eagle」会被并成一行，金额相加，站点信息直接丢失，
-- 拿去补建联时根本不知道该找哪个站点的人。
-- 归因本身的身份键一直是「站点 + 归一化昵称」，这里必须对齐。
--
-- 归一化也统一用 attribution_norm_name（与引擎的 normalizeName 一致），
-- 不再用 lower(btrim())——后者不做 NFKC、也不把占位符归空。
CREATE OR REPLACE FUNCTION public.attribution_run_unmatched_top(_run_id uuid, _limit integer DEFAULT 200)
RETURNS TABLE (country text, account_name text, gmv numeric, rows_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT
    r.country,
    (array_agg(r.account_name ORDER BY r.gmv_usd DESC))[1] AS account_name,
    sum(r.gmv_usd) AS gmv,
    sum(r.rows_count)::bigint AS rows_count
  FROM public.attribution_run_rows r
  WHERE r.run_id = _run_id
    AND r.bucket = 'UNMATCHED'
    AND public.attribution_norm_name(r.account_name) <> ''
  GROUP BY r.country, public.attribution_norm_name(r.account_name)
  ORDER BY sum(r.gmv_usd) DESC
  LIMIT _limit;
$$;

REVOKE ALL ON FUNCTION public.attribution_run_unmatched_top(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_unmatched_top(uuid, integer) TO service_role;
