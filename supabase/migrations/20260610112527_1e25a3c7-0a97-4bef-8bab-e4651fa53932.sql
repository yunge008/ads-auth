CREATE TABLE public.authorize_cron_state (
  id           text PRIMARY KEY,
  last_run_at  timestamptz NOT NULL DEFAULT now(),
  success      integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  no_account   integer NOT NULL DEFAULT 0,
  rounds       integer NOT NULL DEFAULT 0,
  errors       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.authorize_cron_state TO service_role;

ALTER TABLE public.authorize_cron_state ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER authorize_cron_state_touch
  BEFORE UPDATE ON public.authorize_cron_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();