-- 1) 导出「唯一VID汇总」时带上归属人。
--
-- 导出的粒度是 站点 × VID × 商品ID，而判定键的粒度是 站点 × VID × 达人昵称 × 内容类型，
-- 所以一个 (站点, VID) 可能对应多条判定（同一个视频既有视频行也有直播行等）。
-- 这里按 GMV 最大的那条取归属——那才是这个 VID 主要的钱的去向，与报表口径不冲突。
CREATE OR REPLACE FUNCTION public.attribution_run_owner_by_vid(_run_id uuid)
RETURNS TABLE (
  country text,
  vid text,
  staff text,
  role text,
  match_type text,
  bucket text,
  gmv_usd numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT DISTINCT ON (t.country, t.vid)
    t.country, t.vid, t.staff, t.role, t.match_type, t.bucket, t.gmv_usd
  FROM (
    SELECT r.country, r.vid, r.staff, r.role, r.match_type, r.bucket, sum(r.gmv_usd) AS gmv_usd
    FROM public.attribution_run_rows r
    WHERE r.run_id = _run_id AND r.vid <> ''
    GROUP BY r.country, r.vid, r.staff, r.role, r.match_type, r.bucket
  ) t
  ORDER BY t.country, t.vid, t.gmv_usd DESC;
$$;

REVOKE ALL ON FUNCTION public.attribution_run_owner_by_vid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_owner_by_vid(uuid) TO service_role;

-- 2) 无建联达人趋势：原来在 Edge Function 里按 GMV 降序取前 5000 条明细再聚合，
--    而一个月的无建联明细有几万条，**取前 5000 条等于把长尾整段截掉**，
--    表里的月度数字会比真实值小，跨月对比也不公平（每个月截断的位置不一样）。
--    改成在库内直接按 (站点, 归一化昵称) 聚合后返回，不截断。
CREATE OR REPLACE FUNCTION public.attribution_run_unmatched_by_creator(_run_id uuid)
RETURNS TABLE (
  country text,
  account_name text,
  name_norm text,
  gmv_usd numeric,
  rows_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT
    r.country,
    -- 同一个归一化名可能有多种原始写法，取 GMV 最大的那种做展示名
    (array_agg(r.account_name ORDER BY r.gmv_usd DESC))[1] AS account_name,
    public.attribution_norm_name(r.account_name) AS name_norm,
    sum(r.gmv_usd) AS gmv_usd,
    sum(r.rows_count)::bigint AS rows_count
  FROM public.attribution_run_rows r
  WHERE r.run_id = _run_id
    AND r.bucket = 'UNMATCHED'
    AND public.attribution_norm_name(r.account_name) <> ''
  GROUP BY r.country, public.attribution_norm_name(r.account_name);
$$;

REVOKE ALL ON FUNCTION public.attribution_run_unmatched_by_creator(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_unmatched_by_creator(uuid) TO service_role;
