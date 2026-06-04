-- Lock down staff_sheets: drop open policies and revoke anon/authenticated access.
-- All reads/writes will go through edge function `staff-sheets` (service_role + passcode).
DROP POLICY IF EXISTS "open read" ON public.staff_sheets;
DROP POLICY IF EXISTS "open write" ON public.staff_sheets;
DROP POLICY IF EXISTS "open update" ON public.staff_sheets;
DROP POLICY IF EXISTS "open delete" ON public.staff_sheets;

REVOKE ALL ON public.staff_sheets FROM anon;
REVOKE ALL ON public.staff_sheets FROM authenticated;
REVOKE ALL ON public.staff_sheets FROM PUBLIC;
GRANT ALL ON public.staff_sheets TO service_role;