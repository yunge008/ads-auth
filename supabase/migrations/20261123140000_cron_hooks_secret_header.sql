-- 公开 hook 不再接受 publishable key 作为调用方凭证；pg_cron 改为携带 vault 中的 x-cron-key。
DO $$
DECLARE
  base text := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/';
  hdr text := 'jsonb_build_object(''Content-Type'',''application/json'',''x-cron-key'',public.get_gmv_cron_secret())';
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('authorize-daily-1900-bjt','authorize-cron','{}',600000),
    ('attribution-snapshot-nightly','attribution-cron','{}',600000),
    ('feishu-sync-nightly','feishu-sync-cron','{}',600000),
    ('balance-alert-daily','balance-alert-cron','{}',600000),
    ('sea-inventory-day','sea-inventory-cron','{"slot":"day"}',600000),
    ('sea-inventory-night','sea-inventory-cron','{"slot":"night"}',600000),
    ('tts-token-refresh','tts-token-cron','{}',300000)
  ) AS t(jobname, path, body, tmo)
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = r.jobname) THEN
      PERFORM cron.alter_job(
        job_id := (SELECT jobid FROM cron.job WHERE jobname = r.jobname),
        command := format('select net.http_post(url := %L, headers := %s, body := %L::jsonb, timeout_milliseconds := %s);',
                          base || r.path, hdr, r.body, r.tmo)
      );
    END IF;
  END LOOP;
END $$;
