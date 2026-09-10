-- 归并键显式带上站点。一个批次只对应一个站点，所以结果和之前一致，
-- 但把「站点」写进 GROUP BY 之后，归并口径就是明确的 站点 × VID × 达人昵称 × 商品ID × 内容类型 × 币种。
-- 归并层只存可相加的数值（GMV / 成本 / 订单 / 曝光 / 点击）；ROI、CTR、CVR 这类比率不存，
-- 一律在出报表时用汇总后的分子分母重算，避免「比率的平均」这种错误口径。
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
    upper(btrim(_country)),
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
    upper(btrim(_country)),
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
