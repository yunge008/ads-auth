-- Append-only log for both manual and cron authorization runs.
CREATE TABLE public.authorize_log (
  id          bigserial PRIMARY KEY,
  logged_at   timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL DEFAULT 'manual',   -- 'manual' | 'cron'
  success     integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  no_account  integer NOT NULL DEFAULT 0,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  note        text
);

ALTER TABLE public.authorize_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.authorize_log
  USING (auth.role() = 'service_role');
