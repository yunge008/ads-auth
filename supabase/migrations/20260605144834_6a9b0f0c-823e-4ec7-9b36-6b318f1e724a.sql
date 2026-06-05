
-- 1. State table
CREATE TABLE IF NOT EXISTS public.gmv_max_sync_state (
  id text PRIMARY KEY,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  note text
);
GRANT SELECT, INSERT, UPDATE ON public.gmv_max_sync_state TO authenticated;
GRANT ALL ON public.gmv_max_sync_state TO service_role;
ALTER TABLE public.gmv_max_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read sync state" ON public.gmv_max_sync_state FOR SELECT TO authenticated USING (true);

INSERT INTO public.gmv_max_sync_state (id, last_synced_at, note)
VALUES ('gmv_max_vid_daily', now(), 'initial')
ON CONFLICT (id) DO NOTHING;

-- 2. Vault secret for cron bypass
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'gmv_max_cron_secret') THEN
    PERFORM vault.create_secret('1eec5a5c1791a5ed2aedeeaaa26573162c591564b4ae7f37', 'gmv_max_cron_secret');
  END IF;
END $$;

-- 3. RPC to verify cron key from the edge function (service_role only)
CREATE OR REPLACE FUNCTION public.verify_gmv_cron_key(_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'gmv_max_cron_secret' AND decrypted_secret = _key
  );
$$;
REVOKE ALL ON FUNCTION public.verify_gmv_cron_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_gmv_cron_key(text) TO service_role;

-- 4. Enable required extensions for cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
