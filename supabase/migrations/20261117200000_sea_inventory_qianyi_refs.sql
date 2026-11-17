-- SEA库存监控：千易仓库名称（负责人 2026-11-17 确认；千易账号为海外站 asia.qianyierp.com）
-- 需在 20261117190000_sea_inventory.sql 之后执行
UPDATE public.sea_inv_warehouses SET provider_ref = 'ARTPHRO-MY', note = '千易 ERP 海外站，仓库「ARTPHRO-MY」', updated_at = now() WHERE code = 'QY-MY';
UPDATE public.sea_inv_warehouses SET provider_ref = 'ARTPHRO.PH', note = '千易 ERP 海外站，仓库「ARTPHRO.PH」', updated_at = now() WHERE code = 'QY-PH';
