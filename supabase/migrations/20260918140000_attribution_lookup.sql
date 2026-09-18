-- 归因查询：给一个 VID 或达人昵称，回答「它归给了谁、哪个时间段、凭什么」。
--
-- 三块数据一次取齐，对应人脑里的三个问题：
--   1. 归因结果  —— 每个月的快照里这条数据算给了谁（按月分段，这就是「对应时间段」）
--   2. 登记记录  —— 建联表/授权记录/剪辑表里谁登记过它、什么日期（归因判定的原始依据）
--   3. 当前归属  —— creator_ownership 里这个达人现在归谁、保护期算到哪天
--
-- 只读，不参与任何判定。走 RPC 返回单个 JSON：PostgREST 默认 1000 行上限对
-- RETURNS TABLE 会静默截断，这个坑项目里已经踩过两次（判定键、未建联达人）。

CREATE OR REPLACE FUNCTION public.attribution_lookup(
  _q text,
  _limit integer DEFAULT 10,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q       text := btrim(coalesce(_q, ''));
  is_vid  boolean;
  nq      text;
  lim     integer := least(greatest(coalesce(_limit, 10), 1), 200);
  off     integer := greatest(coalesce(_offset, 0), 0);
  total   integer;
  rows_j  jsonb;
  reg_j   jsonb;
  own_j   jsonb;
BEGIN
  IF q = '' THEN
    RETURN jsonb_build_object('query', '', 'total', 0, 'rows', '[]'::jsonb, 'registry', '[]'::jsonb, 'ownership', '[]'::jsonb);
  END IF;
  -- 纯数字且 15–20 位 = 按 VID 精确匹配；否则按达人名字模糊匹配
  is_vid := q ~ '^\d{15,20}$';
  nq := public.attribution_norm_name(q);

  -- 每个月只看最新一次快照，否则同一个月的多次重算会重复出行
  WITH latest AS (
    SELECT DISTINCT ON (r.month) r.id, r.month
    FROM public.attribution_runs r
    ORDER BY r.month DESC, COALESCE(r.finished_at, r.started_at) DESC
  ),
  hit AS (
    SELECT
      rr.month, rr.country, rr.vid, rr.account_name, rr.creative_type,
      rr.bucket, rr.staff, rr.role, rr.match_type, rr.handover_applied,
      rr.posted_at, rr.rows_count, rr.gmv_usd
    FROM public.attribution_run_rows rr
    JOIN latest l ON l.id = rr.run_id
    WHERE (is_vid AND rr.vid = q)
       OR (NOT is_vid AND public.attribution_norm_name(rr.account_name) LIKE '%' || nq || '%')
  )
  SELECT count(*)::integer INTO total FROM hit;

  WITH latest AS (
    SELECT DISTINCT ON (r.month) r.id, r.month
    FROM public.attribution_runs r
    ORDER BY r.month DESC, COALESCE(r.finished_at, r.started_at) DESC
  ),
  hit AS (
    SELECT
      rr.month, rr.country, rr.vid, rr.account_name, rr.creative_type,
      rr.bucket, rr.staff, rr.role, rr.match_type, rr.handover_applied,
      rr.posted_at, rr.rows_count, rr.gmv_usd
    FROM public.attribution_run_rows rr
    JOIN latest l ON l.id = rr.run_id
    WHERE (is_vid AND rr.vid = q)
       OR (NOT is_vid AND public.attribution_norm_name(rr.account_name) LIKE '%' || nq || '%')
    ORDER BY rr.month DESC, rr.gmv_usd DESC
    LIMIT lim OFFSET off
  )
  SELECT coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) INTO rows_j FROM hit h;

  -- 登记侧：谁登记过它。VID 查询时把同 VID 的登记行全列出来（多人登记一眼看见）
  SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.d NULLS FIRST), '[]'::jsonb) INTO reg_j
  FROM (
    SELECT
      cr.country, cr.staff_name, cr.role,
      COALESCE(cr.register_date, cr.sample_date) AS d,
      cr.register_date, cr.sample_date,
      cr.nickname_raw, NULLIF(cr.handle_raw, '') AS handle_raw, cr.vid,
      cr.source, cr.source_sheet, cr.row_number
    FROM public.creator_registry cr
    WHERE (is_vid AND cr.vid = q)
       OR (NOT is_vid AND (
             public.attribution_norm_name(cr.nickname_raw) LIKE '%' || nq || '%'
             OR public.attribution_norm_name(cr.handle_raw) LIKE '%' || nq || '%'
           ))
    LIMIT 200
  ) g;

  -- 当前归属：这个达人现在归谁（昵称键与用户名键都列）
  SELECT coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) INTO own_j
  FROM (
    SELECT co.country, co.key_type, co.match_key, co.display_name, co.owner_bd,
           co.first_register_date, co.owner_last_register_date, co.transfer_count
    FROM public.creator_ownership co
    WHERE (NOT is_vid AND co.match_key LIKE '%' || nq || '%')
       OR (is_vid AND co.match_key IN (
             SELECT public.attribution_norm_name(cr.nickname_raw)
             FROM public.creator_registry cr WHERE cr.vid = q AND cr.nickname_raw <> ''
           ))
    LIMIT 50
  ) o;

  RETURN jsonb_build_object(
    'query', q,
    'is_vid', is_vid,
    'total', total,
    'limit', lim,
    'offset', off,
    'rows', rows_j,
    'registry', reg_j,
    'ownership', own_j
  );
END;
$$;
REVOKE ALL ON FUNCTION public.attribution_lookup(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_lookup(text, integer, integer) TO service_role;

-- 按 VID 查是最常用的入口，run_rows 上补一个索引（月份维度的索引已有）
CREATE INDEX IF NOT EXISTS attribution_run_rows_vid_idx ON public.attribution_run_rows(vid) WHERE vid <> '';
