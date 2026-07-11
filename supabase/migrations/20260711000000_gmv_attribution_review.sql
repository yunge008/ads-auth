-- GMV attribution review implementation (2026-07-11).
-- Extends the un-deployed prototype without rewriting its migration history.

-- Creator identity is scoped to the actual country/site.
ALTER TABLE public.creator_ownership DROP CONSTRAINT IF EXISTS creator_ownership_key_type_match_key_key;
ALTER TABLE public.creator_ownership
  ADD CONSTRAINT creator_ownership_country_key_type_match_key_key UNIQUE (country, key_type, match_key);
CREATE INDEX IF NOT EXISTS creator_ownership_scoped_key_idx
  ON public.creator_ownership (country, key_type, match_key);

ALTER TABLE public.creator_alias DROP CONSTRAINT IF EXISTS creator_alias_alias_norm_key;
ALTER TABLE public.creator_alias
  ADD CONSTRAINT creator_alias_country_norm_source_key UNIQUE (country, alias_norm, source);
CREATE INDEX IF NOT EXISTS creator_alias_scoped_key_idx ON public.creator_alias (country, alias_norm);

-- Goal groups: one row can cover multiple sites; duplicate display must never be summed.
ALTER TABLE public.gmv_targets DROP CONSTRAINT IF EXISTS gmv_targets_month_staff_name_role_key;
ALTER TABLE public.gmv_targets ADD COLUMN IF NOT EXISTS sites text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.gmv_targets ADD COLUMN IF NOT EXISTS material_target integer NOT NULL DEFAULT 0;
ALTER TABLE public.gmv_targets ADD COLUMN IF NOT EXISTS target_group_id text;
UPDATE public.gmv_targets
SET target_group_id = COALESCE(target_group_id, md5(month || '|' || staff_name || '|' || role || '|legacy'));
ALTER TABLE public.gmv_targets ALTER COLUMN target_group_id SET NOT NULL;
ALTER TABLE public.gmv_targets
  ADD CONSTRAINT gmv_targets_month_staff_role_group_key UNIQUE (month, staff_name, role, target_group_id);
CREATE INDEX IF NOT EXISTS gmv_targets_month_staff_role_idx ON public.gmv_targets(month, staff_name, role);

-- Front-end maintained currency rates.  Every completed detail row stores its applied rate.
CREATE TABLE IF NOT EXISTS public.gmv_exchange_rates (
  currency text PRIMARY KEY,
  usd_rate numeric NOT NULL CHECK (usd_rate > 0),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
GRANT ALL ON public.gmv_exchange_rates TO service_role;
ALTER TABLE public.gmv_exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.gmv_exchange_rates FOR ALL TO service_role USING (true) WITH CHECK (true);
INSERT INTO public.gmv_exchange_rates(currency, usd_rate, enabled)
VALUES ('USD', 1, true)
ON CONFLICT (currency) DO NOTHING;

-- Immutable successful calculation batches are the single source for pages, Feishu snapshots and exports.
CREATE TABLE IF NOT EXISTS public.attribution_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  trigger_source text NOT NULL DEFAULT 'MANUAL' CHECK (trigger_source IN ('MANUAL','SCHEDULED','RECALCULATE')),
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_reason text,
  created_by text
);
CREATE INDEX IF NOT EXISTS attribution_batches_month_success_idx ON public.attribution_batches(month, status, completed_at DESC);
GRANT ALL ON public.attribution_batches TO service_role;
ALTER TABLE public.attribution_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_batches FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.attribution_batch_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.attribution_batches(id) ON DELETE CASCADE,
  month text NOT NULL,
  vid text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  tt_account_name text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'USD',
  posted_at timestamptz,
  posted_at_source text,
  active_days integer NOT NULL DEFAULT 0,
  gross_revenue_original numeric NOT NULL DEFAULT 0,
  cost_original numeric NOT NULL DEFAULT 0,
  usd_rate numeric NOT NULL DEFAULT 1,
  gmv_usd numeric NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  orders bigint NOT NULL DEFAULT 0,
  attr_bucket text NOT NULL,
  attr_staff text,
  attr_role text,
  attr_logic text,
  default_owner text,
  handover_applied boolean NOT NULL DEFAULT false,
  target_group_id text,
  performance_counted boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, month, vid, country, tt_account_name, creative_type, currency)
);
CREATE INDEX IF NOT EXISTS attribution_batch_details_lookup_idx ON public.attribution_batch_details(month, country, vid);
CREATE INDEX IF NOT EXISTS attribution_batch_details_batch_idx ON public.attribution_batch_details(batch_id, attr_staff);
GRANT ALL ON public.attribution_batch_details TO service_role;
ALTER TABLE public.attribution_batch_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_batch_details FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.attribution_run_state (
  month text PRIMARY KEY,
  active_batch_id uuid REFERENCES public.attribution_batches(id),
  locked_until timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.attribution_run_state TO service_role;
ALTER TABLE public.attribution_run_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_run_state FOR ALL TO service_role USING (true) WITH CHECK (true);