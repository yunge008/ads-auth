-- 广告户启用/停用开关：国家唯一性只在 active=true 的广告户之间强制。
ALTER TABLE public.advertiser_countries ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
