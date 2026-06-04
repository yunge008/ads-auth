CREATE TABLE public.app_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  passcode_hash text NOT NULL UNIQUE,
  is_admin boolean NOT NULL DEFAULT false,
  tab_permissions text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.app_accounts TO service_role;

ALTER TABLE public.app_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.app_accounts
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER app_accounts_touch BEFORE UPDATE ON public.app_accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();