-- GMV 归因体系：达人登记/归属解析/站点交接/别名/审查/目标/Excel 上传 + 月度聚合 RPC
-- 见 docs/ARCHITECTURE.md「GMV 归因」一节。

-- 1. creator_registry — 达人登记原始行（建联表/授权记录归档/剪辑表），按 source_sheet 全量重建
CREATE TABLE public.creator_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('JIANLIAN','ARCHIVE','EDITOR')),
  source_sheet text NOT NULL,
  row_number integer,
  role text NOT NULL CHECK (role IN ('BD','EDITOR')),
  staff_name text NOT NULL,
  staff_active boolean NOT NULL DEFAULT true,
  register_date date,
  sample_date date,
  country text NOT NULL DEFAULT '',
  handle_raw text NOT NULL DEFAULT '',
  handle_norm text NOT NULL DEFAULT '',
  nickname_raw text NOT NULL DEFAULT '',
  nickname_norm text NOT NULL DEFAULT '',
  vid text NOT NULL DEFAULT '',
  registered_sku text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.creator_registry TO service_role;
ALTER TABLE public.creator_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_registry FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_registry_touch BEFORE UPDATE ON public.creator_registry
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX creator_registry_nick_idx ON public.creator_registry(nickname_norm);
CREATE INDEX creator_registry_handle_idx ON public.creator_registry(handle_norm);
CREATE INDEX creator_registry_vid_idx ON public.creator_registry(vid);
CREATE INDEX creator_registry_staff_idx ON public.creator_registry(staff_name);
CREATE INDEX creator_registry_sheet_idx ON public.creator_registry(source_sheet);

-- 2. creator_ownership — 昵称/用户名 → BD 当前归属（保护期解析结果），全量重建
CREATE TABLE public.creator_ownership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_type text NOT NULL CHECK (key_type IN ('NICKNAME','HANDLE')),
  match_key text NOT NULL,
  display_name text,
  country text NOT NULL DEFAULT '',
  owner_bd text NOT NULL,
  first_register_date date,
  owner_last_register_date date,
  transfer_count integer NOT NULL DEFAULT 0,
  evidence jsonb,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_type, match_key)
);
GRANT ALL ON public.creator_ownership TO service_role;
ALTER TABLE public.creator_ownership ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_ownership FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_ownership_touch BEFORE UPDATE ON public.creator_ownership
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX creator_ownership_key_idx ON public.creator_ownership(match_key);

-- 3. site_handovers — 站点交接（昵称归因按发布时间分段），从飞书「站点交接」全量重建
CREATE TABLE public.site_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL,
  from_bd text NOT NULL,
  to_bd text NOT NULL,
  handover_date date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, handover_date, from_bd, to_bd)
);
GRANT ALL ON public.site_handovers TO service_role;
ALTER TABLE public.site_handovers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.site_handovers FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER site_handovers_touch BEFORE UPDATE ON public.site_handovers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX site_handovers_country_idx ON public.site_handovers(country);

-- 4. creator_alias — 昵称别名（VID 推断 / 人工判定），MANUAL 永不被自动覆盖（应用层保证）
CREATE TABLE public.creator_alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_norm text NOT NULL UNIQUE,
  alias_display text,
  bd_name text NOT NULL,
  country text NOT NULL DEFAULT '',
  source text NOT NULL CHECK (source IN ('VID_INFERRED','MANUAL')),
  evidence_vids integer NOT NULL DEFAULT 0,
  evidence jsonb,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.creator_alias TO service_role;
ALTER TABLE public.creator_alias ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.creator_alias FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER creator_alias_touch BEFORE UPDATE ON public.creator_alias
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 5. attribution_review — 归因审查项（回写飞书/读回人工判定的锚），按 review_key upsert
CREATE TABLE public.attribution_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_key text NOT NULL UNIQUE,
  review_type text NOT NULL CHECK (review_type IN
    ('VID_DUAL_SOURCE','ALIAS_VOTE_CONFLICT','PROTECTION_GRAB','KEYTYPE_CONFLICT','HANDOVER_BOUNDARY')),
  subject text NOT NULL,
  detail jsonb,
  default_resolution text,
  manual_bd text,
  manual_note text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.attribution_review TO service_role;
ALTER TABLE public.attribution_review ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.attribution_review FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER attribution_review_touch BEFORE UPDATE ON public.attribution_review
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX attribution_review_status_idx ON public.attribution_review(status);

-- 6. gmv_targets — 月度 GMV 目标（飞书「GMV目标」同步）
CREATE TABLE public.gmv_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL,
  staff_name text NOT NULL,
  role text NOT NULL DEFAULT 'BD' CHECK (role IN ('BD','EDITOR')),
  target_usd numeric NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, staff_name, role)
);
GRANT ALL ON public.gmv_targets TO service_role;
ALTER TABLE public.gmv_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.gmv_targets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER gmv_targets_touch BEFORE UPDATE ON public.gmv_targets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX gmv_targets_month_idx ON public.gmv_targets(month);

-- 7. ad_uploads / ad_upload_rows — 上传的广告表（文件名「站点 MAX yyyymm.xlsx」）
CREATE TABLE public.ad_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  country text NOT NULL DEFAULT '',
  month text NOT NULL DEFAULT '',
  uploaded_by text,
  period_start date,
  period_end date,
  row_count integer NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  total_revenue numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'UPLOADING' CHECK (status IN ('UPLOADING','READY','FAILED')),
  attributed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.ad_uploads TO service_role;
ALTER TABLE public.ad_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.ad_uploads FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER ad_uploads_touch BEFORE UPDATE ON public.ad_uploads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX ad_uploads_month_idx ON public.ad_uploads(month, country);

CREATE TABLE public.ad_upload_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.ad_uploads(id) ON DELETE CASCADE,
  row_no integer NOT NULL,
  campaign_name text,
  campaign_id text NOT NULL DEFAULT '',
  product_id text NOT NULL DEFAULT '',
  creative_type text NOT NULL DEFAULT '',
  video_title text,
  vid text NOT NULL DEFAULT '',
  tt_account_name text NOT NULL DEFAULT '',
  posted_at timestamptz,
  status text,
  authorization_type text,
  cost numeric NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  gross_revenue numeric NOT NULL DEFAULT 0,
  roi numeric,
  impressions bigint,
  clicks bigint,
  currency text,
  attr_bucket text,
  attr_staff text,
  attr_source text,
  attr_match_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, row_no)
);
GRANT ALL ON public.ad_upload_rows TO service_role;
ALTER TABLE public.ad_upload_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.ad_upload_rows FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX ad_upload_rows_upload_idx ON public.ad_upload_rows(upload_id);
CREATE INDEX ad_upload_rows_vid_idx ON public.ad_upload_rows(vid);

-- 8. gmv_max_vid_meta 加发布时间（API metric 实测有效后由 gmv-max-sync 写入；存量行走 VID>>32 兜底）
ALTER TABLE public.gmv_max_vid_meta
  ADD COLUMN IF NOT EXISTS posted_at timestamptz;

-- 9. 月度归因聚合 RPC：把日明细压到 (vid, 账号, 内容类型, 国家, 货币) 组，避免 Edge Function 拉全量
CREATE OR REPLACE FUNCTION public.gmv_attr_monthly_agg(
  _start date, _end date, _limit integer DEFAULT 1000, _offset integer DEFAULT 0
)
RETURNS TABLE (
  vid text, tt_account_name text, shop_content_type text,
  country text, currency text, posted_at timestamptz,
  cost numeric, gross_revenue numeric, orders bigint, active_days integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT d.vid,
         COALESCE(NULLIF(d.tt_account_name, ''), m.tt_account_name, '')     AS tt_account_name,
         COALESCE(NULLIF(d.shop_content_type, ''), m.shop_content_type, '') AS shop_content_type,
         COALESCE(d.country, '')                                            AS country,
         COALESCE(NULLIF(d.currency, ''), 'USD')                            AS currency,
         MAX(m.posted_at)                                                   AS posted_at,
         SUM(d.cost)                                                        AS cost,
         SUM(d.gross_revenue)                                               AS gross_revenue,
         SUM(d.orders)::bigint                                              AS orders,
         COUNT(DISTINCT d.stat_date)::integer                               AS active_days
  FROM public.gmv_max_vid_daily d
  LEFT JOIN public.gmv_max_vid_meta m ON m.vid = d.vid
  WHERE d.stat_date >= _start AND d.stat_date <= _end
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4, 5
  LIMIT _limit OFFSET _offset;
$$;
REVOKE ALL ON FUNCTION public.gmv_attr_monthly_agg(date, date, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gmv_attr_monthly_agg(date, date, integer, integer) TO service_role;
