CREATE OR REPLACE FUNCTION public.attribution_upload_rows_update(
  _upload_id uuid,
  _rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  affected integer;
BEGIN
  IF jsonb_typeof(_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '_rows must be a JSON array';
  END IF;

  UPDATE public.ad_upload_rows AS target
  SET
    attr_bucket = source.attr_bucket,
    attr_staff = source.attr_staff,
    attr_source = source.attr_source,
    attr_match_type = source.attr_match_type
  FROM jsonb_to_recordset(_rows) AS source(
    row_no integer,
    attr_bucket text,
    attr_staff text,
    attr_source text,
    attr_match_type text
  )
  WHERE target.upload_id = _upload_id
    AND target.row_no = source.row_no;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

REVOKE ALL ON FUNCTION public.attribution_upload_rows_update(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attribution_upload_rows_update(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.attribution_upload_rows_update(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_upload_rows_update(uuid, jsonb) TO service_role;