-- SEA库存监控：最少改动分配（负责人 2026-11-18）——低于预警天数（min_days）的 listing 补到 target_days 天销量
ALTER TABLE public.sea_inv_settings ADD COLUMN IF NOT EXISTS target_days numeric NOT NULL DEFAULT 30 CHECK (target_days > 0);
