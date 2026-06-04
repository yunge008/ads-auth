
CREATE POLICY "service role only" ON public.staff_sheets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service role only" ON public.tiktok_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);
