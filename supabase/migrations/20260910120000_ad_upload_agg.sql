-- 归因与上传解耦：上传只负责把广告表原始行落库并按 (VID, 达人昵称, 商品ID, 内容类型, 币种) 归并；
-- 归因结果不再在 finalize 时固化到 ad_upload_rows.attr_*，改为出报表时用「当下的飞书登记数据」现算。
-- 归并后每个批次通常只剩几千行（原始 10 万行级），现算归因才跑得动。

CREATE TABLE IF NOT EXISTS public.ad_upload_agg (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.ad_uploads(id) ON DELETE CASCADE,
  country text NOT NULL DEFAULT '',
  month text NOT NULL DEFAULT '',
  vid text NOT NULL DEFAULT '',
  account_name text NOT NULL DEFAULT '',
  product_id text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'USD',
  -- 组内最早的发布时间；为空时归因引擎按 VID>>32 推算
  posted_at timestamptz,
  rows_count integer NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  gross_revenue numeric NOT NULL DEFAULT 0,
  orders bigint NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, vid, account_name, product_id, creative_type, currency)
);

GRANT ALL ON public.ad_upload_agg TO service_role;
ALTER TABLE public.ad_upload_agg ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role only" ON public.ad_upload_agg;
CREATE POLICY "service role only" ON public.ad_upload_agg FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS ad_upload_agg_upload_idx ON public.ad_upload_agg(upload_id);
CREATE INDEX IF NOT EXISTS ad_upload_agg_month_idx ON public.ad_upload_agg(month, country);
CREATE INDEX IF NOT EXISTS ad_upload_agg_vid_idx ON public.ad_upload_agg(vid);

-- 按批次重建归并表。整个 GROUP BY 在数据库里做，Edge Function 不必把 10 万行拉出来再写回去。
CREATE OR REPLACE FUNCTION public.attribution_build_upload_agg(_upload_id uuid)
RETURNS TABLE (agg_rows integer, raw_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
DECLARE
  _country text;
  _month text;
  _agg integer;
  _raw bigint;
BEGIN
  SELECT u.country, u.month INTO _country, _month FROM public.ad_uploads u WHERE u.id = _upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '上传批次不存在: %', _upload_id;
  END IF;

  SELECT count(*) INTO _raw FROM public.ad_upload_rows r WHERE r.upload_id = _upload_id;

  DELETE FROM public.ad_upload_agg WHERE upload_id = _upload_id;

  INSERT INTO public.ad_upload_agg (
    upload_id, country, month, vid, account_name, product_id, creative_type, currency,
    posted_at, rows_count, cost, gross_revenue, orders, impressions, clicks
  )
  SELECT
    _upload_id,
    _country,
    _month,
    r.vid,
    btrim(r.tt_account_name),
    r.product_id,
    r.creative_type,
    upper(coalesce(nullif(btrim(r.currency), ''), 'USD')),
    min(r.posted_at),
    count(*)::integer,
    sum(r.cost),
    sum(r.gross_revenue),
    sum(r.orders)::bigint,
    sum(coalesce(r.impressions, 0))::bigint,
    sum(coalesce(r.clicks, 0))::bigint
  FROM public.ad_upload_rows r
  WHERE r.upload_id = _upload_id
  GROUP BY
    r.vid,
    btrim(r.tt_account_name),
    r.product_id,
    r.creative_type,
    upper(coalesce(nullif(btrim(r.currency), ''), 'USD'));

  GET DIAGNOSTICS _agg = ROW_COUNT;
  RETURN QUERY SELECT _agg, _raw;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_build_upload_agg(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_build_upload_agg(uuid) TO service_role;

-- 清空全部批次时把归并表一起 TRUNCATE（ad_upload_agg 有 FK，必须在同一条语句里）
CREATE OR REPLACE FUNCTION public.attribution_uploads_delete_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.ad_uploads;
  TRUNCATE TABLE public.ad_upload_agg, public.ad_upload_rows, public.ad_uploads;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_uploads_delete_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_uploads_delete_all() TO service_role;
