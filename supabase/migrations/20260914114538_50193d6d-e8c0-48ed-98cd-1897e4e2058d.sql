ALTER TABLE public.attribution_run_candidates ADD COLUMN IF NOT EXISTS chunk_no integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS attribution_run_candidates_chunk_idx
  ON public.attribution_run_candidates(run_id, country, chunk_no);

DROP FUNCTION IF EXISTS public.attribution_seed_run_keys(uuid, text);

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