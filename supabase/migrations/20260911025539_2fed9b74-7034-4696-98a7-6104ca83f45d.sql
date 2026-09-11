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