REVOKE EXECUTE ON FUNCTION public.verify_gmv_cron_key(text) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_gmv_cron_key(text) TO service_role;