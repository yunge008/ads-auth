-- SEA库存监控：预组装件没货时的「单品组套」需先在仓库系统做组合映射（负责人 2026-11-18）
--   sea_inv_plan_items.advisory：只提醒、不执行的计划项
--   sea_inv_sku_map.assemble_ok：人工确认该 listing 已在仓库系统映射为单品组合，之后预组装件没货时自动按单品组套
ALTER TABLE public.sea_inv_plan_items ADD COLUMN IF NOT EXISTS advisory boolean NOT NULL DEFAULT false;
ALTER TABLE public.sea_inv_sku_map
  ADD COLUMN IF NOT EXISTS assemble_ok    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assemble_ok_by text,
  ADD COLUMN IF NOT EXISTS assemble_ok_at timestamptz;
