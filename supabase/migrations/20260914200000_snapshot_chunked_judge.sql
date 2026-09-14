-- 判定分片：一次调用只判一小块，彻底绕开 Edge Function 的 CPU 配额。
--
-- 实测（用户侧 Excel 透视对账）2026-08 共 250,275 条素材，其中 38.9% 是真能归到人的，
-- 所以「只把候选键送进引擎」最多把 25 万压到 12 万——2 倍，仍然超 CPU 预算。
-- 唯一可行的办法是把判定拆成多次请求，每次判固定条数。
--
-- 拆分必须保证**别名投票不被打散**：引擎从「VID 命中的视频行」给同名达人推别名，
-- 投票与消费都发生在同一个 (站点, 归一化昵称) 内部，不跨组。
-- 所以只要同一个 (站点, 昵称) 的键永远落在同一片里，分片判定与一次性判定结果完全等价。
-- 这里用窗口函数按 (站点, 昵称) 分组累加行数来切片，天然满足这个约束。
--
-- 进度用「候选表里还剩多少行」表示：判完一片就把那片删掉，剩 0 即全部判完。
-- 不另外存状态，中途失败重跑也只会重做没删掉的那部分。

ALTER TABLE public.attribution_run_candidates ADD COLUMN IF NOT EXISTS chunk_no integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS attribution_run_candidates_chunk_idx
  ON public.attribution_run_candidates(run_id, country, chunk_no);

-- seed 返回值要带上分片计划，改了返回类型，先删旧签名
DROP FUNCTION IF EXISTS public.attribution_seed_run_keys(uuid, text);

-- 一次扫描分三件事：
--   1) 非候选键 → attribution_run_keys，按内容类型直接定桶
--   2) 候选键   → attribution_run_candidates
--   3) 给候选键编好分片号（同一 (站点, 昵称) 必在同一片），返回分片计划
CREATE OR REPLACE FUNCTION public.attribution_seed_run_keys(
  _run_id uuid, _month text, _chunk_size integer DEFAULT 15000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '300s'
AS $$
DECLARE
  _seeded bigint;
  _cand bigint;
  _plan jsonb;
BEGIN
  DELETE FROM public.attribution_run_candidates WHERE run_id = _run_id;
  DELETE FROM public.attribution_run_keys WHERE run_id = _run_id;

  CREATE TEMP TABLE _ext ON COMMIT DROP AS
    SELECT * FROM public.attribution_month_keys_ext(_month);

  INSERT INTO public.attribution_run_keys (
    run_id, country, vid, account_name, creative_type,
    bucket, staff, role, match_type, handover_applied
  )
  SELECT
    _run_id, k.country, k.vid, k.account_name, k.creative_type,
    CASE k.ctype
      WHEN 'product_card' THEN 'PRODUCT_CARD'
      WHEN 'other' THEN 'OTHER'
      ELSE 'UNMATCHED'
    END,
    NULL, NULL, NULL, false
  FROM _ext k
  WHERE NOT k.is_candidate;
  GET DIAGNOSTICS _seeded = ROW_COUNT;

  INSERT INTO public.attribution_run_candidates (run_id, country, vid, account_name, creative_type, posted_at)
  SELECT _run_id, k.country, k.vid, k.account_name, k.creative_type, k.posted_at
  FROM _ext k
  WHERE k.is_candidate;
  GET DIAGNOSTICS _cand = ROW_COUNT;

  -- 分片号：在每个站点内，按 (归一化昵称) 分组累加行数后整除片大小。
  -- 昵称为空的键只可能走 VID 路径、与任何别名投票无关，按 VID 分组即可。
  WITH g AS (
    SELECT
      c.country,
      CASE
        WHEN public.attribution_norm_name(c.account_name) <> ''
          THEN public.attribution_norm_name(c.account_name)
        ELSE '\x01' || c.vid
      END AS grp,
      count(*) AS n
    FROM public.attribution_run_candidates c
    WHERE c.run_id = _run_id
    GROUP BY 1, 2
  ),
  s AS (
    SELECT
      g.country,
      g.grp,
      ((sum(g.n) OVER (PARTITION BY g.country ORDER BY g.grp ROWS UNBOUNDED PRECEDING) - 1)
        / greatest(_chunk_size, 1))::integer AS chunk_no
    FROM g
  )
  UPDATE public.attribution_run_candidates c
  SET chunk_no = s.chunk_no
  FROM s
  WHERE c.run_id = _run_id
    AND c.country = s.country
    AND CASE
          WHEN public.attribution_norm_name(c.account_name) <> ''
            THEN public.attribution_norm_name(c.account_name)
          ELSE '\x01' || c.vid
        END = s.grp;

  SELECT coalesce(jsonb_agg(t ORDER BY t.keys DESC), '[]'::jsonb) INTO _plan
  FROM (
    SELECT c.country, c.chunk_no, count(*)::bigint AS keys
    FROM public.attribution_run_candidates c
    WHERE c.run_id = _run_id
    GROUP BY c.country, c.chunk_no
  ) t;

  RETURN jsonb_build_object('seeded', _seeded, 'candidates', _cand, 'plan', _plan);
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_seed_run_keys(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_seed_run_keys(uuid, text, integer) TO service_role;

-- 取下一片待判定的键（不指定就自己挑剩下的第一片）。返回 JSON 数组，单行，不受 1000 行上限约束。
DROP FUNCTION IF EXISTS public.attribution_candidate_keys_json(uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.attribution_next_chunk_json(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  _country text;
  _chunk integer;
  _keys jsonb;
  _left bigint;
BEGIN
  SELECT c.country, c.chunk_no INTO _country, _chunk
  FROM public.attribution_run_candidates c
  WHERE c.run_id = _run_id
  ORDER BY c.country, c.chunk_no
  LIMIT 1;

  IF _country IS NULL THEN
    RETURN jsonb_build_object('done', true, 'remaining', 0);
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO _keys
  FROM (
    SELECT c.country, c.vid, c.account_name, c.creative_type, c.posted_at
    FROM public.attribution_run_candidates c
    WHERE c.run_id = _run_id AND c.country = _country AND c.chunk_no = _chunk
    ORDER BY c.seq
  ) t;

  SELECT count(*) INTO _left
  FROM public.attribution_run_candidates c
  WHERE c.run_id = _run_id;

  RETURN jsonb_build_object(
    'done', false,
    'country', _country,
    'chunk_no', _chunk,
    'remaining', _left,
    'keys', _keys
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_next_chunk_json(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_next_chunk_json(uuid) TO service_role;

-- 判完一片就删掉，剩余行数即进度。
CREATE OR REPLACE FUNCTION public.attribution_drop_chunk(_run_id uuid, _country text, _chunk integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  _left bigint;
BEGIN
  DELETE FROM public.attribution_run_candidates
  WHERE run_id = _run_id AND country = _country AND chunk_no = _chunk;

  SELECT count(*) INTO _left
  FROM public.attribution_run_candidates WHERE run_id = _run_id;
  RETURN _left;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_drop_chunk(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_drop_chunk(uuid, text, integer) TO service_role;

-- 判某个站点时，引擎的 VID 强匹配仍然是全局的（VID 在别的站点登记过也算命中）。
-- 上下文按站点收窄之后，这部分会漏，所以单独把「这个站点的候选键用到、但登记在别处」的 VID 登记捞出来补上。
CREATE OR REPLACE FUNCTION public.attribution_vid_regs_for_country(_run_id uuid, _country text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT jsonb_build_object(
    'registry', coalesce((
      SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT DISTINCT g.vid, g.staff_name, g.role, g.register_date, g.country
        FROM public.creator_registry g
        WHERE g.vid <> ''
          AND g.country IS DISTINCT FROM _country
          AND EXISTS (
            SELECT 1 FROM public.attribution_run_candidates c
            WHERE c.run_id = _run_id AND c.country = _country AND c.vid = g.vid
          )
      ) t
    ), '[]'::jsonb),
    'vid_map', coalesce((
      SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT DISTINCT m.vid, m.staff_name, m.source_type, m.country
        FROM public.staff_vid_map m
        WHERE m.vid <> ''
          AND m.country IS DISTINCT FROM _country
          AND EXISTS (
            SELECT 1 FROM public.attribution_run_candidates c
            WHERE c.run_id = _run_id AND c.country = _country AND c.vid = m.vid
          )
      ) t
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.attribution_vid_regs_for_country(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_vid_regs_for_country(uuid, text) TO service_role;
