-- 快照重算被 Edge Function 的 **CPU 配额**掐死（日志：`CPU Time exceeded`），不是网关超时。
-- 2026-08 有 250,296 个判定键，光把它们解析成 JS 对象、再序列化写回，就超出了单次调用的 CPU 预算。
-- 往返次数已经压到 13 次，没用——瓶颈换成了 CPU。
--
-- 关键观察：这些键里**绝大多数根本没有任何可能归到人**（VID 不在登记表、达人昵称也不在归属表），
-- 引擎对它们的判定结果必然是 UNMATCHED；商品卡和认不出的类型更是只看内容类型就能定桶。
-- 这部分完全不需要进 JS。
--
-- 所以这里在数据库里先做一次**候选筛选**：
--   · 非候选键（占绝大多数）→ 直接按内容类型在库内定桶写进 attribution_run_keys
--   · 候选键（VID 能对上，或昵称在归属表/别名表/别名投票名单里）→ 才交给引擎判
-- 判定逻辑仍然只有 TS 引擎一份，SQL 只负责「这条有没有可能归到人」这个纯粹的存在性问题。
--
-- 候选判定故意**偏宽**：宁可多送几条进引擎，也不能漏判。特别是别名投票——
-- 引擎会从「VID 命中的视频行」给同名达人推出别名，所以这些名字即使不在归属表里也必须算候选。

-- 昵称归一化：必须与 TS 的 normalizeName 完全一致（NFKC → 去首尾 → 折叠空白 → 小写 → 占位符归空）。
-- Postgres 13+ 的 normalize() 提供 NFKC，所以两边能对齐。
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

-- 站点归一化：必须与 TS 的 identityKey 一致（NFKC → 去首尾 → 折叠空白 → **大写**）。
-- 两边都归一化后再比，才不会因为大小写或多余空格把本来能匹配的键判成非候选。
CREATE OR REPLACE FUNCTION public.attribution_norm_site(_s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT upper(btrim(regexp_replace(normalize(coalesce(_s, ''), NFKC), '\s+', ' ', 'g')));
$$;

-- 内容类型归一化：与 TS 的 normalizeCreativeType 一一对应，判定顺序也一致。
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

-- 整月判定键 + 「要不要送进引擎」的标记。读键与写种子都走这一个定义，避免两边判据跑偏。
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
  -- 该键的 VID 在登记表里有登记（两张来源表任一即可）
  marked AS (
    SELECT k.*,
           k.vid <> '' AND (
             EXISTS (SELECT 1 FROM public.creator_registry g WHERE g.vid = k.vid)
             OR EXISTS (SELECT 1 FROM public.staff_vid_map m WHERE m.vid = k.vid)
           ) AS vid_hit
    FROM keys k
  ),
  -- 别名投票来源：只有「视频 + VID 命中」的行会投票（与引擎 Pass 1 的顺序一致，
  -- 商品卡 / 其他 / 直播 在投票之前就已经分流走了）
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

-- 候选键落地表：attribution_month_keys_ext 一次要扫整月归并表、还要做多次 EXISTS，
-- 每翻一页都重算一遍代价太大。所以 seed 的时候顺手把候选键写进这张表，翻页只读它。
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

-- 一次扫描分两路写：
--   非候选键 → attribution_run_keys，按内容类型直接定桶（与引擎对这些键的判定完全一致：
--             商品卡 → PRODUCT_CARD，认不出的类型 → OTHER，其余 → UNMATCHED）
--   候选键   → attribution_run_candidates，等 Edge Function 分页取走交给引擎
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

-- 候选键分页读取：只读落地表，按 seq 顺序稳定翻页；仍然打成一个 JSON（单行）返回，绕开 1000 行上限。
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

-- 旧签名（按月份取候选）已被按 run_id 取代，删掉避免重载歧义。
DROP FUNCTION IF EXISTS public.attribution_candidate_keys_json(text, integer, integer);
