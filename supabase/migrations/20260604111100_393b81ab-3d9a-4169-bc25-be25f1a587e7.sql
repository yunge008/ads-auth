CREATE TABLE public.advertiser_countries (
  advertiser_id text PRIMARY KEY,
  country text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.advertiser_countries TO service_role;

ALTER TABLE public.advertiser_countries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.advertiser_countries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER touch_advertiser_countries_updated_at
  BEFORE UPDATE ON public.advertiser_countries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();