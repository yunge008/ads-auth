-- 【第 1 步 / 共 3 步】只加列，秒级完成。
--
-- 金额改为「归并时就按后台汇率折成 USD 存下来」，后续环节只做加法、不再有汇率分支。
-- usd_rate 记录归并当时用的汇率（1 美元 = 多少本币），可追溯、可重算。
--
-- 注意：这三个文件要分开执行。上一版把「存量数据补算」写成了一条全表 UPDATE，
-- 几十万行跑不完，SQL 编辑器超时后整个事务回滚，报的就是没有错误码的「Server Error」。

ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS usd_rate numeric;
ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS gmv_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE public.ad_upload_agg ADD COLUMN IF NOT EXISTS cost_usd numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ad_upload_agg.usd_rate IS '归并时用的汇率（1 美元 = 多少本币）。NULL = 当时缺该币种汇率或尚未补算，gmv_usd/cost_usd 记 0。';

-- 存量行按月补算的入口见第 2 步的 attribution_rebuild_agg_usd / attribution_backfill_agg_usd，
-- 生成快照时也会自动补，不需要在这里做全表 UPDATE。
CREATE INDEX IF NOT EXISTS ad_upload_agg_usd_backfill_idx
  ON public.ad_upload_agg(upload_id) WHERE usd_rate IS NULL;
