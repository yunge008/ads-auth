REVOKE ALL ON FUNCTION public.attribution_unmatched_trend(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_unmatched_trend(text[]) TO service_role;
ALTER FUNCTION public.attribution_unmatched_trend(text[]) SET statement_timeout = '120s';