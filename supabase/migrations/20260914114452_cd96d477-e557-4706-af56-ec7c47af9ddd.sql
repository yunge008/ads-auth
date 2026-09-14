CREATE OR REPLACE FUNCTION public.attribution_norm_name(_s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN t IN ('-', 'n/a', 'na', 'none', 'null') THEN '' ELSE t END
  FROM (
    SELECT lower(btrim(regexp_replace(normalize(coalesce(_s, ''), NFKC), '\s+', ' ', 'g'))) AS t
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.attribution_norm_site(_s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT upper(btrim(regexp_replace(normalize(coalesce(_s, ''), NFKC), '\s+', ' ', 'g')));
$$;

CREATE OR REPLACE FUNCTION public.attribution_norm_creative_type(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN s = '' THEN 'other'
    WHEN lower(s) IN ('视频', 'video') THEN 'video'
    WHEN lower(s) IN ('商品卡片', 'product card', 'product_card', '商品卡') THEN 'product_card'
    WHEN lower(s) IN ('直播', 'live') THEN 'live'
    WHEN upper(s) LIKE '%CARD%' OR s LIKE '%商品卡%' THEN 'product_card'
    WHEN upper(s) LIKE '%LIVE%' OR s LIKE '%直播%' THEN 'live'
    WHEN upper(s) LIKE '%VIDEO%' OR s LIKE '%视频%' THEN 'video'
    ELSE 'other'
  END
  FROM (SELECT btrim(coalesce(_raw, '')) AS s) x;
$$;

CREATE OR REPLACE FUNCTION public.attribution_month_keys_ext(_month text)
RETURNS TABLE (
  country text,
  vid text,
  account_name text,
  creative_type text,
  posted_at timestamptz,
  ctype text,
  is_candidate boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '180s'
AS $$
  WITH keys AS (
    SELECT
      a.country,
      a.vid,
      a.account_name,
      a.creative_type,
      min(a.posted_at) AS posted_at,
      public.attribution_norm_name(a.account_name) AS nm,
      public.attribution_norm_site(a.country) AS site,
      public.attribution_norm_creative_type(a.creative_type) AS ctype
    FROM public.ad_upload_agg a
    JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
    WHERE a.month = _month
    GROUP BY a.country, a.vid, a.account_name, a.creative_type
  ),
  marked AS (
    SELECT k.*,
           k.vid <> '' AND (
             EXISTS (SELECT 1 FROM public.creator_registry g WHERE g.vid = k.vid)
             OR EXISTS (SELECT 1 FROM public.staff_vid_map m WHERE m.vid = k.vid)
           ) AS vid_hit
    FROM keys k
  ),
  vote_names AS (
    SELECT DISTINCT m.site, m.nm
    FROM marked m
    WHERE m.vid_hit AND m.ctype = 'video' AND m.nm <> ''
  )
  SELECT
    m.country,
    m.vid,
    m.account_name,
    m.creative_type,
    m.posted_at,
    m.ctype,
    (
      m.vid_hit
      OR (
        m.nm <> '' AND (
          EXISTS (
            SELECT 1 FROM public.creator_ownership c
            WHERE public.attribution_norm_site(c.country) = m.site AND c.match_key = m.nm
          )
          OR EXISTS (
            SELECT 1 FROM public.creator_alias al
            WHERE public.attribution_norm_site(al.country) = m.site AND al.alias_norm = m.nm
          )
          OR EXISTS (SELECT 1 FROM vote_names v WHERE v.site = m.site AND v.nm = m.nm)
        )
      )
    ) AS is_candidate
  FROM marked m;
$$;

REVOKE ALL ON FUNCTION public.attribution_month_keys_ext(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_month_keys_ext(text) TO service_role;

CREATE TABLE IF NOT EXISTS public.attribution_run_candidates (
  seq bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.attribution_runs(id) ON DELETE CASCADE,
  country text NOT NULL DEFAULT '',
  vid text NOT NULL DEFAULT '',
  account_name text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  posted_at timestamptz
);

GRANT ALL ON public.attribution_run_candidates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.attribution_run_candidates_seq_seq TO service_role;
ALTER TABLE public.attribution_run_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only" ON public.attribution_run_candidates;
CREATE POLICY "service role only" ON public.attribution_run_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS attribution_run_candidates_run_idx ON public.attribution_run_candidates(run_id, seq);

CREATE OR REPLACE FUNCTION public.attribution_seed_run_keys(_run_id uuid, _month text)
RETURNS TABLE (seeded bigint, candidates bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '300s'
AS $$
DECLARE
  _seeded bigint;
  _cand bigint;
BEGIN
  DELETE FROM public.attribution_run_candidates WHERE run_id = _run_id;

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
  WHERE k.is_candidate
  ORDER BY k.country, k.vid, k.account_name, k.creative_type;
  GET DIAGNOSTICS _cand = ROW_COUNT;

  RETURN QUERY SELECT _seeded, _cand;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_seed_run_keys(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_seed_run_keys(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.attribution_candidate_keys_json(
  _run_id uuid, _limit integer DEFAULT 20000, _offset integer DEFAULT 0
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
    SELECT c.country, c.vid, c.account_name, c.creative_type, c.posted_at
    FROM public.attribution_run_candidates c
    WHERE c.run_id = _run_id
    ORDER BY c.seq
    LIMIT _limit OFFSET _offset
  ) t;
$$;

REVOKE ALL ON FUNCTION public.attribution_candidate_keys_json(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_candidate_keys_json(uuid, integer, integer) TO service_role;

DROP FUNCTION IF EXISTS public.attribution_candidate_keys_json(text, integer, integer);