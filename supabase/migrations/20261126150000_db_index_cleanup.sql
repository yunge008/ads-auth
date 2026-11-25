-- 2026-11-26 数据库容量治理 A 类（负责人 2026-11-26 同意直接执行）：删除重复/被覆盖的索引，重建两张空中转表的索引。
-- 不改任何数据、不改任何查询结果；查询改走保留下来的等价索引。实测（2026-11-26 只读通道）约省 430 MB。
--
-- 1. ad_upload_agg_month_vid_product_idx 与 ad_upload_agg_month_country_vid_product_idx 定义完全相同
--    （都是 (month, country, vid, product_id)；20260914162046 / 20260915140000 用了旧名字重复建了一份）—— 232 MB
DROP INDEX IF EXISTS public.ad_upload_agg_month_vid_product_idx;
-- 2. (month, country) 是 (month, country, vid, product_id) 的前缀 —— 20 MB
DROP INDEX IF EXISTS public.ad_upload_agg_month_idx;
-- 3. (upload_id) 是唯一键 (upload_id, vid, account_name, product_id, creative_type, currency) 的前缀 —— 20 MB
DROP INDEX IF EXISTS public.ad_upload_agg_upload_idx;
-- 4. ad_upload_rows：(upload_id, row_no) 与唯一约束 ad_upload_rows_upload_id_row_no_key 重复；(upload_id) 是其前缀 —— 24 MB
DROP INDEX IF EXISTS public.ad_upload_rows_upload_rowno_idx;
DROP INDEX IF EXISTS public.ad_upload_rows_upload_idx;
-- 5. 两张中转表平时是空的（上传归并完 / 快照算完就删），但删行不会缩小索引：重建后约省 134 MB。
--    下次上传或算快照时会按当次数据量重新长大，属正常。执行时避开正在上传/算快照的时候（REINDEX 期间这两张表不能写）。
REINDEX TABLE public.ad_upload_rows;
REINDEX TABLE public.attribution_run_candidates;
