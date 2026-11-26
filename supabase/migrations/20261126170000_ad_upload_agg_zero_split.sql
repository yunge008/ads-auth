-- 2026-11-26 归并层全 0 行压缩（负责人 2026-11-26 定：零消耗行压成窄表，计数和身份构建照常可用）。
--
-- 背景：ad_upload_agg 约 85% 的行花费、GMV、订单、曝光、点击全为 0（Excel 里列出但没花钱的视频 × 商品）。
-- 做法：
--   1. 原表改名 ad_upload_agg_nz，只放「至少一项非 0」的行（列、索引、约束、RLS 不变）。
--   2. 新表 ad_upload_agg_zero 放全 0 行，只存：批次、站点、月、VID、昵称、商品 ID、内容类型、币种、发布时间、原始行数。
--      比负责人列的「站点、月、VID、昵称、发布时间」多了 批次 / 商品 ID / 内容类型 / 币种 / 原始行数：
--      批次用于删除与重新归并；内容类型、币种是归因判定键与快照分组的一部分；商品 ID 让「唯一 VID 导出」逐行不变；
--      原始行数让对账行数不变。少了任何一项，下面「结果不变」就不成立。
--   3. 视图 ad_upload_agg（原名）= 两表 UNION ALL，全 0 行的金额列补 0、汇率按当前启用汇率补（与归并时同一取法）。
--      所有读 ad_upload_agg 的函数、Edge Function、服务端路由不用改，读到的行与改前相同。
--   4. 只改写入方：attribution_build_upload_agg / _part（非 0 → nz，全 0 → zero）、clear / delete_all（两表都清）、
--      汇率回填 / 重算（只更新 nz；zero 行的汇率在视图里实时取）。
--   5. 依赖原表的诊断视图 attribution_posted_at_gap 按原定义重建在新视图上（否则会只看到非 0 行）。
-- 已知差异（不影响任何金额、计数）：
--   - 视图里全 0 行的 id 由键算出（md5），created_at 为空；没有代码读 created_at。
--   - 全 0 行的 usd_rate 取当前启用汇率；改前是归并当时写入的值。只影响「缺汇率」判断：某币种只出现在全 0 行、且没配汇率时，
--     改前算「有行缺汇率」，改后一样算（视图取不到汇率即为空），汇率被停用的情况改后会显示缺汇率——与非 0 行在下次重算后的结果一致。
-- 新增防护（原有隐患）：attribution_build_upload_agg 会先删后建，原始行已清理（10-13 起归并完即删）时重跑会把归并层清空；
--   现在原始行为 0 且已有归并数据时直接报错，不删任何东西。
-- 执行后：跑一次 attribution_agg_move_zero（见文末），再单独 VACUUM FULL public.ad_upload_agg_nz; 才会把空间还给磁盘。

-- ---------- 1. 改名 + 窄表 ----------
ALTER TABLE public.ad_upload_agg RENAME TO ad_upload_agg_nz;

CREATE TABLE public.ad_upload_agg_zero (
  upload_id     uuid NOT NULL REFERENCES public.ad_uploads(id) ON DELETE CASCADE,
  posted_at     timestamptz,
  rows_count    integer NOT NULL DEFAULT 0,
  country       text NOT NULL DEFAULT '',
  month         text NOT NULL DEFAULT '',
  vid           text NOT NULL DEFAULT '',
  account_name  text NOT NULL DEFAULT '',
  product_id    text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  currency      text NOT NULL DEFAULT 'USD'
);
-- 两个索引键重复度高，B-tree 去重后很小；不建唯一索引（省空间），重跑幂等由写入函数「先删本片再插」保证
CREATE INDEX ad_upload_agg_zero_upload_idx ON public.ad_upload_agg_zero (upload_id);
CREATE INDEX ad_upload_agg_zero_month_idx ON public.ad_upload_agg_zero (month, country);

ALTER TABLE public.ad_upload_agg_zero ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.ad_upload_agg_zero FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.ad_upload_agg_zero FROM anon, authenticated;
GRANT ALL ON public.ad_upload_agg_zero TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') THEN
    EXECUTE 'CREATE POLICY ai_reader_select ON public.ad_upload_agg_zero FOR SELECT TO ai_reader USING (true)';
    EXECUTE 'GRANT SELECT ON public.ad_upload_agg_zero TO ai_reader';
  END IF;
END $$;

-- ---------- 2. 同名视图 ----------
-- security_invoker：按调用者权限读底表，走底表 RLS（anon / authenticated 读不到，与原表一致）
CREATE VIEW public.ad_upload_agg WITH (security_invoker = true) AS
SELECT n.id, n.upload_id, n.country, n.month, n.vid, n.account_name, n.product_id, n.creative_type, n.currency,
       n.posted_at, n.rows_count, n.cost, n.gross_revenue, n.orders, n.impressions, n.clicks,
       n.created_at, n.usd_rate, n.gmv_usd, n.cost_usd
FROM public.ad_upload_agg_nz n
UNION ALL
SELECT md5(concat_ws(chr(31), z.upload_id::text, z.vid, z.account_name, z.product_id, z.creative_type, z.currency))::uuid,
       z.upload_id, z.country, z.month, z.vid, z.account_name, z.product_id, z.creative_type, z.currency,
       z.posted_at, z.rows_count, 0::numeric, 0::numeric, 0::bigint, 0::bigint, 0::bigint,
       NULL::timestamptz,
       rt.usd_rate,
       -- 与归并时同一算式（0 ÷ 汇率），连小数位数都与原表一致
       CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE 0::numeric / rt.usd_rate END,
       CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE 0::numeric / rt.usd_rate END
FROM public.ad_upload_agg_zero z
LEFT JOIN LATERAL (
  SELECT CASE WHEN z.currency = 'USD'
              THEN coalesce((SELECT er.usd_rate FROM public.gmv_exchange_rates er
                              WHERE er.currency = 'USD' AND er.enabled = true AND er.usd_rate > 0 LIMIT 1), 1)
              ELSE (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                     WHERE er.currency = z.currency AND er.enabled = true AND er.usd_rate > 0 LIMIT 1)
         END AS usd_rate
) rt ON true;

REVOKE ALL ON public.ad_upload_agg FROM anon, authenticated;
GRANT SELECT ON public.ad_upload_agg TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') THEN
    EXECUTE 'GRANT SELECT ON public.ad_upload_agg TO ai_reader';
  END IF;
END $$;

-- ---------- 3. 诊断视图改到新视图上（定义与原来逐字相同） ----------
DROP VIEW IF EXISTS public.attribution_posted_at_gap;
CREATE VIEW public.attribution_posted_at_gap WITH (security_invoker = true) AS
 WITH vid_known AS (
         SELECT DISTINCT creator_registry.vid
           FROM creator_registry
          WHERE creator_registry.vid <> ''::text
        UNION
         SELECT DISTINCT staff_vid_map.vid
           FROM staff_vid_map
          WHERE staff_vid_map.vid <> ''::text
        ), rows AS (
         SELECT a.month,
            a.country,
            a.gmv_usd,
            a.creative_type,
            a.posted_at,
            attribution_needs_posted_at(a.creative_type) AS needs_posted_at,
            a.vid <> ''::text AND (EXISTS ( SELECT 1
                   FROM vid_known k
                  WHERE k.vid = a.vid)) AS vid_attributed
           FROM ad_upload_agg a
             JOIN ad_uploads u ON u.id = a.upload_id AND u.status = 'READY'::text
        )
 SELECT month,
    country,
    count(*) FILTER (WHERE needs_posted_at AND posted_at IS NULL) AS missing_rows,
    count(*) FILTER (WHERE needs_posted_at) AS need_posted_at_rows,
    count(*) AS total_rows,
    round(100.0 * sum(gmv_usd) FILTER (WHERE needs_posted_at AND posted_at IS NULL) / NULLIF(sum(gmv_usd) FILTER (WHERE needs_posted_at), 0::numeric), 2) AS missing_gmv_pct,
    round(sum(gmv_usd) FILTER (WHERE needs_posted_at AND posted_at IS NULL), 2) AS missing_gmv_usd,
    round(sum(gmv_usd) FILTER (WHERE needs_posted_at AND posted_at IS NULL AND NOT vid_attributed), 2) AS pending_gmv_usd,
    round(100.0 * sum(gmv_usd) FILTER (WHERE needs_posted_at AND posted_at IS NULL AND NOT vid_attributed) / NULLIF(sum(gmv_usd), 0::numeric), 2) AS pending_gmv_pct_of_total,
    round(sum(gmv_usd) FILTER (WHERE NOT needs_posted_at), 2) AS no_posted_at_by_design_usd,
    round(sum(gmv_usd), 2) AS total_gmv_usd
   FROM rows
  GROUP BY month, country;
REVOKE ALL ON public.attribution_posted_at_gap FROM anon, authenticated;
GRANT SELECT ON public.attribution_posted_at_gap TO service_role;

-- ---------- 4. 写入方 ----------
-- 4a. 分片归并：非 0 → nz（原逻辑，ON CONFLICT DO NOTHING 保证重跑幂等）；全 0 → zero（先删本片再插，同样幂等）
CREATE OR REPLACE FUNCTION public.attribution_build_upload_agg_part(_upload_id uuid, _parts integer, _part integer)
 RETURNS TABLE(agg_rows integer, raw_rows bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  _country text;
  _month text;
  _agg integer;
  _zero integer;
  _raw bigint;
BEGIN
  IF _parts < 1 OR _part < 0 OR _part >= _parts THEN
    RAISE EXCEPTION '分片参数不合法: parts=%, part=%', _parts, _part;
  END IF;

  SELECT u.country, u.month INTO _country, _month FROM public.ad_uploads u WHERE u.id = _upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '上传批次不存在: %', _upload_id;
  END IF;

  DROP TABLE IF EXISTS _agg_src;
  CREATE TEMP TABLE _agg_src ON COMMIT DROP AS
    SELECT
      r.vid,
      btrim(r.tt_account_name) AS account_name,
      r.product_id,
      r.creative_type,
      upper(coalesce(nullif(btrim(r.currency), ''), 'USD')) AS currency,
      min(r.posted_at) AS posted_at,
      count(*)::integer AS rows_count,
      sum(r.cost) AS cost,
      sum(r.gross_revenue) AS gross_revenue,
      sum(r.orders)::bigint AS orders,
      sum(coalesce(r.impressions, 0))::bigint AS impressions,
      sum(coalesce(r.clicks, 0))::bigint AS clicks
    FROM public.ad_upload_rows r
    WHERE r.upload_id = _upload_id
      AND mod(
            abs(hashtextextended(
              concat_ws(
                chr(31),
                coalesce(r.vid, ''),
                btrim(coalesce(r.tt_account_name, '')),
                coalesce(r.product_id, ''),
                coalesce(r.creative_type, ''),
                upper(coalesce(nullif(btrim(r.currency), ''), 'USD'))
              ),
              0)),
            _parts) = _part
    GROUP BY
      r.vid,
      btrim(r.tt_account_name),
      r.product_id,
      r.creative_type,
      upper(coalesce(nullif(btrim(r.currency), ''), 'USD'));

  INSERT INTO public.ad_upload_agg_nz (
    upload_id, country, month, vid, account_name, product_id, creative_type, currency,
    posted_at, rows_count, cost, gross_revenue, orders, impressions, clicks,
    usd_rate, gmv_usd, cost_usd
  )
  SELECT
    _upload_id,
    upper(btrim(_country)),
    _month,
    s.vid, s.account_name, s.product_id, s.creative_type, s.currency,
    s.posted_at, s.rows_count, s.cost, s.gross_revenue, s.orders, s.impressions, s.clicks,
    rt.usd_rate,
    CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE s.gross_revenue / rt.usd_rate END,
    CASE WHEN rt.usd_rate IS NULL THEN 0 ELSE s.cost / rt.usd_rate END
  FROM _agg_src s
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN s.currency = 'USD' THEN coalesce(
               (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                 WHERE er.currency = 'USD' AND er.enabled = true AND er.usd_rate > 0), 1)
             ELSE (SELECT er.usd_rate FROM public.gmv_exchange_rates er
                    WHERE er.currency = s.currency AND er.enabled = true AND er.usd_rate > 0)
           END AS usd_rate
  ) rt ON true
  WHERE NOT (coalesce(s.cost, 0) = 0 AND coalesce(s.gross_revenue, 0) = 0 AND coalesce(s.orders, 0) = 0
             AND s.impressions = 0 AND s.clicks = 0)
  ON CONFLICT (upload_id, vid, account_name, product_id, creative_type, currency) DO NOTHING;
  GET DIAGNOSTICS _agg = ROW_COUNT;

  DELETE FROM public.ad_upload_agg_zero z
  WHERE z.upload_id = _upload_id
    AND mod(abs(hashtextextended(concat_ws(chr(31), z.vid, z.account_name, z.product_id, z.creative_type, z.currency), 0)), _parts) = _part;

  INSERT INTO public.ad_upload_agg_zero (
    upload_id, posted_at, rows_count, country, month, vid, account_name, product_id, creative_type, currency
  )
  SELECT _upload_id, s.posted_at, s.rows_count, upper(btrim(_country)), _month,
         s.vid, s.account_name, s.product_id, s.creative_type, s.currency
  FROM _agg_src s
  WHERE coalesce(s.cost, 0) = 0 AND coalesce(s.gross_revenue, 0) = 0 AND coalesce(s.orders, 0) = 0
    AND s.impressions = 0 AND s.clicks = 0
    -- 同键已在 nz（极端情况：之前按非 0 写入过）就不再写 0 行，避免视图里同键两行
    AND NOT EXISTS (
      SELECT 1 FROM public.ad_upload_agg_nz n
      WHERE n.upload_id = _upload_id AND n.vid = s.vid AND n.account_name = s.account_name
        AND n.product_id = s.product_id AND n.creative_type = s.creative_type AND n.currency = s.currency
    );
  GET DIAGNOSTICS _zero = ROW_COUNT;

  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;
  RETURN QUERY SELECT _agg + _zero, _raw;
END;
$function$;

-- 4b. 整批归并（旧路径 / 自愈补归并）：先删后建；原始行已清理且已有归并数据时报错，不删
CREATE OR REPLACE FUNCTION public.attribution_build_upload_agg(_upload_id uuid)
 RETURNS TABLE(agg_rows integer, raw_rows bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  _raw bigint;
  _agg integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ad_uploads u WHERE u.id = _upload_id) THEN
    RAISE EXCEPTION '上传批次不存在: %', _upload_id;
  END IF;

  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;
  IF _raw = 0 AND (
       EXISTS (SELECT 1 FROM public.ad_upload_agg_nz n WHERE n.upload_id = _upload_id)
       OR EXISTS (SELECT 1 FROM public.ad_upload_agg_zero z WHERE z.upload_id = _upload_id)
     ) THEN
    RAISE EXCEPTION '该批次原始行已清理，不能重新归并（会清空已有数据）；要改归并口径请重新上传原文件';
  END IF;

  DELETE FROM public.ad_upload_agg_nz WHERE upload_id = _upload_id;
  DELETE FROM public.ad_upload_agg_zero WHERE upload_id = _upload_id;

  SELECT b.agg_rows INTO _agg FROM public.attribution_build_upload_agg_part(_upload_id, 1, 0) b;
  RETURN QUERY SELECT _agg, _raw;
END;
$function$;

-- 4c. 清理
CREATE OR REPLACE FUNCTION public.attribution_clear_upload_agg(_upload_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _n integer;
  _z integer;
BEGIN
  DELETE FROM public.ad_upload_agg_nz WHERE upload_id = _upload_id;
  GET DIAGNOSTICS _n = ROW_COUNT;
  DELETE FROM public.ad_upload_agg_zero WHERE upload_id = _upload_id;
  GET DIAGNOSTICS _z = ROW_COUNT;
  RETURN _n + _z;
END;
$function$;

CREATE OR REPLACE FUNCTION public.attribution_uploads_delete_all()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.ad_uploads;
  TRUNCATE TABLE public.ad_upload_agg_nz, public.ad_upload_agg_zero, public.ad_upload_rows, public.ad_uploads;
  RETURN n;
END;
$function$;

-- 4d. 汇率回填 / 重算：只有非 0 行存了金额和汇率
CREATE OR REPLACE FUNCTION public.attribution_backfill_agg_usd(_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  n integer;
BEGIN
  WITH target AS (
    SELECT id FROM public.ad_upload_agg_nz WHERE usd_rate IS NULL LIMIT GREATEST(_limit, 1)
  ),
  rate AS (
    SELECT c.currency,
           CASE WHEN c.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END AS usd_rate
    FROM (SELECT DISTINCT currency FROM public.ad_upload_agg_nz WHERE usd_rate IS NULL) c
    LEFT JOIN public.gmv_exchange_rates er
      ON er.currency = c.currency AND er.enabled = true AND er.usd_rate > 0
  )
  UPDATE public.ad_upload_agg_nz a
  SET usd_rate = rate.usd_rate,
      gmv_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.gross_revenue / rate.usd_rate END,
      cost_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.cost / rate.usd_rate END
  FROM target, rate
  WHERE a.id = target.id AND rate.currency = a.currency AND rate.usd_rate IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.attribution_rebuild_agg_usd(_month text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  n integer;
BEGIN
  UPDATE public.ad_upload_agg_nz a
  SET usd_rate = rate.usd_rate,
      gmv_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.gross_revenue / rate.usd_rate END,
      cost_usd = CASE WHEN rate.usd_rate IS NULL THEN 0 ELSE a.cost / rate.usd_rate END
  FROM (
    SELECT c.currency,
           CASE WHEN c.currency = 'USD' THEN coalesce(er.usd_rate, 1) ELSE er.usd_rate END AS usd_rate
    FROM (SELECT DISTINCT currency FROM public.ad_upload_agg_nz WHERE month = _month) c
    LEFT JOIN public.gmv_exchange_rates er
      ON er.currency = c.currency AND er.enabled = true AND er.usd_rate > 0
  ) AS rate
  WHERE rate.currency = a.currency
    AND a.month = _month
    AND (a.usd_rate IS DISTINCT FROM rate.usd_rate);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

REVOKE ALL ON FUNCTION public.attribution_build_upload_agg_part(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attribution_build_upload_agg(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attribution_clear_upload_agg(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attribution_uploads_delete_all() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attribution_backfill_agg_usd(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attribution_rebuild_agg_usd(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg_part(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.attribution_clear_upload_agg(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.attribution_uploads_delete_all() TO service_role;
GRANT EXECUTE ON FUNCTION public.attribution_backfill_agg_usd(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.attribution_rebuild_agg_usd(text) TO service_role;

-- ---------- 5. 存量搬迁（一次性，按月执行，可重复执行） ----------
-- 用法（SQL Editor，避开上传 / 23:30 快照）：
--   select month, public.attribution_agg_move_zero(month) from (select distinct month from public.ad_uploads order by 1) m;
-- 超时就逐月：select public.attribution_agg_move_zero('2026-08');
CREATE OR REPLACE FUNCTION public.attribution_agg_move_zero(_month text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  n bigint;
BEGIN
  WITH moved AS (
    DELETE FROM public.ad_upload_agg_nz a
    WHERE a.month = _month
      AND a.cost = 0 AND a.gross_revenue = 0 AND a.orders = 0 AND a.impressions = 0 AND a.clicks = 0
    RETURNING a.upload_id, a.posted_at, a.rows_count, a.country, a.month, a.vid, a.account_name, a.product_id, a.creative_type, a.currency
  )
  INSERT INTO public.ad_upload_agg_zero (upload_id, posted_at, rows_count, country, month, vid, account_name, product_id, creative_type, currency)
  SELECT upload_id, posted_at, rows_count, country, month, vid, account_name, product_id, creative_type, currency FROM moved;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 刚搬进来的新表没有统计信息，查询计划会走错（本地实测：唯一 VID 导出 1 秒 → 4 分钟以上），搬完立即更新统计
  ANALYZE public.ad_upload_agg_zero;
  ANALYZE public.ad_upload_agg_nz;
  RETURN n;
END;
$function$;
REVOKE ALL ON FUNCTION public.attribution_agg_move_zero(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_agg_move_zero(text) TO service_role;

NOTIFY pgrst, 'reload schema';
