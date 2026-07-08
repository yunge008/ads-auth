ALTER TABLE public.app_accounts ADD COLUMN IF NOT EXISTS passcode text;
UPDATE public.app_accounts SET passcode = 'facai888' WHERE name = 'yunge008';