-- 归因快照改为「判定在 Edge Function、聚合在数据库」。
--
-- 背景：实测一个 10 万行的批次归并后仍有 9.4 万行（因为归并键里含商品ID），
-- 整月 8~12 个批次就是几十万行。原来的做法是把整月归并行全部拉进 Edge Function 再算再写回，
-- 必然超时/爆内存（表现就是「重新计算失败：Edge Function returned a non-2xx status code」）。
--
-- 新做法：
--   1. Edge Function 只拉「需要判定的去重键」——(站点, VID, 达人昵称, 内容类型)，判定与金额无关；
--   2. 判定结果写进 attribution_run_keys；
--   3. attribution_apply_run 在数据库内 JOIN 归并表 + 判定结果 + 汇率，写出 VID 粒度的快照明细，
--      并返回一份「几百行」的紧凑汇总给 Edge Function 拼成报表 JSON。
-- 去重计数（归因 VID 数 / 归因达人昵称数）也在这一步用 count(DISTINCT) 一并算出。

-- ---------- 1. 判定结果表 ----------

CREATE TABLE IF NOT EXISTS public.attribution_run_keys (
  run_id uuid NOT NULL REFERENCES public.attribution_runs(id) ON DELETE CASCADE,
  country text NOT NULL DEFAULT '',
  vid text NOT NULL DEFAULT '',
  account_name text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  bucket text NOT NULL DEFAULT 'UNMATCHED',
  staff text,
  role text,
  match_type text,
  handover_applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, country, vid, account_name, creative_type)
);

GRANT ALL ON public.attribution_run_keys TO service_role;
ALTER TABLE public.attribution_run_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only" ON public.attribution_run_keys;
CREATE POLICY "service role only" ON public.attribution_run_keys FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 缺汇率的行不计入美元口径，但要能在报表里单独提示
ALTER TABLE public.attribution_run_rows ADD COLUMN IF NOT EXISTS has_rate boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS attribution_run_rows_run_country_idx
  ON public.attribution_run_rows(run_id, country);

-- ---------- 2. 待判定的去重键 ----------

-- 判定只依赖 (站点, VID, 达人昵称, 内容类型)，与商品ID、币种、金额无关，
-- 所以这里先去重，Edge Function 要处理的行数比归并表小一个量级。
CREATE OR REPLACE FUNCTION public.attribution_month_keys(
  _month text, _limit integer DEFAULT 5000, _offset integer DEFAULT 0
)
RETURNS TABLE (country text, vid text, account_name text, creative_type text, posted_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT a.country, a.vid, a.account_name, a.creative_type, min(a.posted_at) AS posted_at
  FROM public.ad_upload_agg a
  JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
  WHERE a.month = _month
  GROUP BY a.country, a.vid, a.account_name, a.creative_type
  ORDER BY a.country, a.vid, a.account_name, a.creative_type
  LIMIT _limit OFFSET _offset;
$$;

REVOKE ALL ON FUNCTION public.attribution_month_keys(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_month_keys(text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.attribution_month_key_count(_month text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT count(*)::bigint FROM (
    SELECT 1
    FROM public.ad_upload_agg a
    JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
    WHERE a.month = _month
    GROUP BY a.country, a.vid, a.account_name, a.creative_type
  ) AS t;
$$;

REVOKE ALL ON FUNCTION public.attribution_month_key_count(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_month_key_count(text) TO service_role;

-- ---------- 3. 数据库内落明细 + 返回紧凑汇总 ----------

CREATE OR REPLACE FUNCTION public.attribution_apply_run(_run_id uuid, _month text)
RETURNS TABLE (
  bucket text, staff text, role text, match_type text, country text, currency text,
  has_rate boolean,
  gmv_native numeric, cost_native numeric, gmv_usd numeric, cost_usd numeric,
  orders bigint, rows_count bigint, vids integer, creators integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
BEGIN
  DELETE FROM public.attribution_run_rows WHERE run_id = _run_id;

  INSERT INTO public.attribution_run_rows (
    run_id, month, country, vid, account_name, product_id, creative_type, currency,
    rows_count, cost, gross_revenue, orders, cost_usd, gmv_usd, has_rate,
    bucket, staff, role, match_type, handover_applied, posted_at
  )
  SELECT
    _run_id,
    _month,
    a.country,
    a.vid,
    a.account_name,
    '',                       -- 明细降到 VID 粒度：商品ID 不再进快照（唯一VID汇总导出仍走归并表）
    a.creative_type,
    a.currency,
    sum(a.rows_count)::integer,
    sum(a.cost),
    sum(a.gross_revenue),
    sum(a.orders)::bigint,
    CASE WHEN (CASE WHEN a.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END) IS NULL
         THEN 0
         ELSE sum(a.cost) / (CASE WHEN a.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END) END,
    CASE WHEN (CASE WHEN a.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END) IS NULL
         THEN 0
         ELSE sum(a.gross_revenue) / (CASE WHEN a.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END) END,
    (CASE WHEN a.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END) IS NOT NULL,
    coalesce(k.bucket, 'UNMATCHED'),
    k.staff,
    k.role,
    k.match_type,
    coalesce(k.handover_applied, false),
    min(a.posted_at)
  FROM public.ad_upload_agg a
  JOIN public.ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'
  LEFT JOIN public.attribution_run_keys k
    ON k.run_id = _run_id
   AND k.country = a.country
   AND k.vid = a.vid
   AND k.account_name = a.account_name
   AND k.creative_type = a.creative_type
  LEFT JOIN public.gmv_exchange_rates er
    ON er.currency = a.currency AND er.enabled = true AND er.usd_rate > 0
  WHERE a.month = _month
  GROUP BY
    a.country, a.vid, a.account_name, a.creative_type, a.currency, er.usd_rate,
    k.bucket, k.staff, k.role, k.match_type, k.handover_applied;

  RETURN QUERY
  SELECT
    x.bucket, x.staff, x.role, x.match_type, x.country, x.currency, x.has_rate,
    sum(x.gross_revenue), sum(x.cost), sum(x.gmv_usd), sum(x.cost_usd),
    sum(x.orders)::bigint, sum(x.rows_count)::bigint,
    count(DISTINCT x.vid) FILTER (WHERE x.vid <> '')::integer,
    count(DISTINCT lower(btrim(x.account_name))) FILTER (WHERE btrim(x.account_name) <> '')::integer
  FROM public.attribution_run_rows x
  WHERE x.run_id = _run_id
  GROUP BY x.bucket, x.staff, x.role, x.match_type, x.country, x.currency, x.has_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_apply_run(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_apply_run(uuid, text) TO service_role;

-- 无建联达人 Top N（报表里的「无建联」清单）
CREATE OR REPLACE FUNCTION public.attribution_run_unmatched_top(_run_id uuid, _limit integer DEFAULT 200)
RETURNS TABLE (account_name text, gmv numeric, rows_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT max(r.account_name), sum(r.gmv_usd), sum(r.rows_count)::bigint
  FROM public.attribution_run_rows r
  WHERE r.run_id = _run_id AND r.bucket = 'UNMATCHED' AND btrim(r.account_name) <> ''
  GROUP BY lower(btrim(r.account_name))
  ORDER BY 2 DESC
  LIMIT _limit;
$$;

REVOKE ALL ON FUNCTION public.attribution_run_unmatched_top(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_run_unmatched_top(uuid, integer) TO service_role;

-- ---------- 4. 清理：只留最近 N 条快照，且只有最新一条保留明细 ----------

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

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_runs_prune(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_runs_prune(text, integer) TO service_role;

-- ---------- 5. 达人登记进度矩阵（数据准备面板用） ----------

CREATE OR REPLACE FUNCTION public.attribution_registry_matrix()
RETURNS TABLE (staff_name text, role text, country text, vids integer, creators integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  SELECT
    g.staff_name,
    g.role,
    g.country,
    count(DISTINCT g.vid) FILTER (WHERE g.vid <> '')::integer,
    count(DISTINCT g.nickname_norm) FILTER (WHERE g.nickname_norm <> '')::integer
  FROM (
    SELECT staff_name, role, upper(btrim(coalesce(country, ''))) AS country,
           coalesce(vid, '') AS vid, coalesce(nickname_norm, '') AS nickname_norm
    FROM public.creator_registry
  ) AS g
  GROUP BY g.staff_name, g.role, g.country;
$$;

REVOKE ALL ON FUNCTION public.attribution_registry_matrix() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_registry_matrix() TO service_role;

-- ---------- 6. 达人粉丝量 ----------

-- 从飞书建联表按表头自动识别「粉丝量/粉丝数/followers」列写入；前台暂不展示，先把数据存下来。
ALTER TABLE public.creator_registry ADD COLUMN IF NOT EXISTS follower_count bigint;
ALTER TABLE public.creator_ownership ADD COLUMN IF NOT EXISTS follower_count bigint;
