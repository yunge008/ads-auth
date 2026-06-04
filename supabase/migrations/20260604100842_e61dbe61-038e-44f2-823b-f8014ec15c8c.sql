CREATE TABLE public.tiktok_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label text NOT NULL,
  access_token text NOT NULL,
  bc_id text,
  advertiser_ids text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.tiktok_connections TO service_role;
ALTER TABLE public.tiktok_connections ENABLE ROW LEVEL SECURITY;
-- No policies = no anon/authenticated access. Only service_role (edge functions) can read/write.

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER tiktok_connections_touch
  BEFORE UPDATE ON public.tiktok_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();