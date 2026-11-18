-- SEA库存监控：各仓在导出文件「仓库」列里的名称（2026-11-18 按四份真实导出核对），批量上传时自动分仓用。
-- 泰国新仓 = BigSeller「AR thailand 泰国」；状态仍为 disabled（不参与调整），负责人确认后在页面改为「新仓接入中」。
UPDATE public.sea_inv_warehouses SET file_config = file_config || '{"warehouse_value":"ARTPHRO-MY"}'::jsonb,       updated_at = now() WHERE code = 'QY-MY';
UPDATE public.sea_inv_warehouses SET file_config = file_config || '{"warehouse_value":"ARTPHRO.PH"}'::jsonb,       updated_at = now() WHERE code = 'QY-PH';
UPDATE public.sea_inv_warehouses SET file_config = file_config || '{"warehouse_value":"GOGO云仓"}'::jsonb,          updated_at = now() WHERE code = 'DM-TH1';
UPDATE public.sea_inv_warehouses SET file_config = file_config || '{"warehouse_value":"artphro -vn"}'::jsonb,      updated_at = now() WHERE code = 'BS-VN';
UPDATE public.sea_inv_warehouses SET file_config = file_config || '{"warehouse_value":"AR thailand 泰国"}'::jsonb,
  provider = 'bigseller', name = 'BigSeller TH 新仓',
  note = 'BigSeller 仓库「AR thailand 泰国」；API 收费，页面上传导出表（之后可改 RPA→云盘）。启用时状态改「新仓接入中」', updated_at = now()
  WHERE code = 'TH-NEW';
