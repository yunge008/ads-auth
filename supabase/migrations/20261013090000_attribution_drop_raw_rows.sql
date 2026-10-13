-- 2026-10-13 数据库容量治理（项目负责人 2026-10-13 确认）：归因上传的原始行（ad_upload_rows）归并完成后不再在线保存。
--
-- 背景：ad_upload_rows 占 2.3 GB（341 万行），是库里最大的表，但它只在「归并」那一步被读：
--   归因报表 / 唯一VID导出 / 自查 / 下钻 / 汇率重算读的都是 ad_upload_agg（归并层）和
--   attribution_run_rows（快照层），这两层全部保留。原始 Excel 由上传人本地留存。
-- 代价：已清理原始行的批次不能再「重新归并」，要改归并口径就得重新上传原文件。
-- 不碰授权（authorize_*、tiktok_connections）和飞书回写相关表。

-- 1. 单批次清理函数：attribution-upload 在 finalize 成功后调用。
--    只清「已 READY 且归并层有数据」的批次；缺汇率等没走完的批次原始行保留，便于补汇率后重跑。
CREATE OR REPLACE FUNCTION public.attribution_purge_upload_rows(_upload_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ad_uploads WHERE id = _upload_id AND status = 'READY') THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ad_upload_agg WHERE upload_id = _upload_id) THEN
    RETURN 0;
  END IF;
  DELETE FROM public.ad_upload_rows WHERE upload_id = _upload_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.attribution_purge_upload_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attribution_purge_upload_rows(uuid) TO service_role;

-- 2. 存量一次性清理：先确认每个还有原始行的批次都已 READY 且归并层有数据，否则整段中止、什么都不删。
--    全部通过后用 TRUNCATE（立即归还磁盘；DELETE 不会）。
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(u.file_name || '（' || u.status || '）', '、')
  INTO bad
  FROM public.ad_uploads u
  WHERE EXISTS (SELECT 1 FROM public.ad_upload_rows r WHERE r.upload_id = u.id)
    AND (u.status <> 'READY' OR NOT EXISTS (SELECT 1 FROM public.ad_upload_agg a WHERE a.upload_id = u.id));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '以下批次还没归并完成，原始行不能清，请先在上传历史里重新归并：%', bad;
  END IF;
  TRUNCATE TABLE public.ad_upload_rows;
END;
$$;

-- 3. GMV Max 官方 API 明细（未上线）。20261012130000 已停 cron，但清空后又被手动同步写入了少量行；再清一次，幂等。
TRUNCATE TABLE public.gmv_max_vid_daily, public.gmv_max_vid_meta;
