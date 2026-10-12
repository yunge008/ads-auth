-- 2026-10-12 数据库容量告警应急：清空尚未上线的 GMV Max 官方 API 同步数据。
-- 只动 GMV Max 同步链路（pg_cron 的 gmv-max-cron job + gmv_max_vid_daily / gmv_max_vid_meta），
-- 不碰授权（authorize_*、tiktok_connections）和归因（ad_upload*、attribution_*、creator_*）。
-- 当前两个「GMV 归因」页面读的是 Excel 上传（ad_upload_rows），不读这两张表。
-- 表结构、索引、RPC 都保留，日后上线重新同步即可回填。

-- 1. 停掉 GMV Max 定时同步（不删则删完很快又被写满）
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE command ILIKE '%gmv-max-cron%' OR command ILIKE '%gmv-max-sync%';

-- 2. 清空明细（TRUNCATE 立即归还磁盘空间；DELETE 不会）
TRUNCATE TABLE public.gmv_max_vid_daily, public.gmv_max_vid_meta;
