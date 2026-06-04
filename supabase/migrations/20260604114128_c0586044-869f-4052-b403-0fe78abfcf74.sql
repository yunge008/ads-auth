
CREATE TABLE public.staff_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sheet_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_sheets TO anon, authenticated;
GRANT ALL ON public.staff_sheets TO service_role;

ALTER TABLE public.staff_sheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "open read"  ON public.staff_sheets FOR SELECT USING (true);
CREATE POLICY "open write" ON public.staff_sheets FOR INSERT WITH CHECK (true);
CREATE POLICY "open update" ON public.staff_sheets FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "open delete" ON public.staff_sheets FOR DELETE USING (true);

CREATE TRIGGER staff_sheets_touch_updated BEFORE UPDATE ON public.staff_sheets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
