-- SEA库存监控：无销量提示门槛 + 超卖（库存不足）判定阈值（负责人 2026-11-28）
--   zero_sale_min_free：无销量 listing 线上 0 件且仓库未分配 > 此件数才提示补货
--   short_wh_days / short_online_days：仓库可分配按全部 listing 日销只够 < short_wh_days 天，且有 listing 线上显示 > short_online_days 天 → 超卖风险
ALTER TABLE public.sea_inv_settings
  ADD COLUMN IF NOT EXISTS zero_sale_min_free int     NOT NULL DEFAULT 10 CHECK (zero_sale_min_free >= 0),
  ADD COLUMN IF NOT EXISTS short_wh_days      numeric NOT NULL DEFAULT 5  CHECK (short_wh_days > 0),
  ADD COLUMN IF NOT EXISTS short_online_days  numeric NOT NULL DEFAULT 6  CHECK (short_online_days > 0);
