
-- 1. tiktok_comments
CREATE TABLE public.tiktok_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id text NOT NULL,
  country text,
  comment_id text NOT NULL UNIQUE,
  parent_comment_id text,
  vid text,
  text text,
  text_zh text,
  like_count integer NOT NULL DEFAULT 0,
  reply_count integer NOT NULL DEFAULT 0,
  username text,
  avatar_url text,
  comment_type text,
  comment_create_time timestamptz,
  pulled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.tiktok_comments TO service_role;
ALTER TABLE public.tiktok_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.tiktok_comments FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER tiktok_comments_touch BEFORE UPDATE ON public.tiktok_comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX tiktok_comments_adv_idx ON public.tiktok_comments(advertiser_id);
CREATE INDEX tiktok_comments_country_idx ON public.tiktok_comments(country);
CREATE INDEX tiktok_comments_vid_idx ON public.tiktok_comments(vid);
CREATE INDEX tiktok_comments_create_idx ON public.tiktok_comments(comment_create_time DESC);

-- 2. staff_vid_map
CREATE TABLE public.staff_vid_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL DEFAULT '',
  staff_name text NOT NULL,
  vid text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('BD','EDITOR')),
  source_sheet text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, staff_name, vid, source_type)
);
GRANT ALL ON public.staff_vid_map TO service_role;
ALTER TABLE public.staff_vid_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.staff_vid_map FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER staff_vid_map_touch BEFORE UPDATE ON public.staff_vid_map
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX staff_vid_map_vid_idx ON public.staff_vid_map(vid);
CREATE INDEX staff_vid_map_country_idx ON public.staff_vid_map(country);

-- 3. sku_product_map
CREATE TABLE public.sku_product_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL DEFAULT '',
  product_id text NOT NULL,
  product_name text,
  sku_id text,
  merchant_sku text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, product_id, merchant_sku)
);
GRANT ALL ON public.sku_product_map TO service_role;
ALTER TABLE public.sku_product_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.sku_product_map FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER sku_product_map_touch BEFORE UPDATE ON public.sku_product_map
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX sku_product_map_pid_idx ON public.sku_product_map(product_id);

-- 4. gmv_max_vid_daily
CREATE TABLE public.gmv_max_vid_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL DEFAULT '',
  advertiser_id text NOT NULL,
  campaign_id text NOT NULL DEFAULT '',
  item_group_id text NOT NULL DEFAULT '',
  vid text NOT NULL DEFAULT '',
  stat_date date NOT NULL,
  creative_delivery_status text,
  cost numeric NOT NULL DEFAULT 0,
  gross_revenue numeric NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  product_impressions bigint NOT NULL DEFAULT 0,
  product_clicks bigint NOT NULL DEFAULT 0,
  roi numeric,
  ctr numeric,
  cvr numeric,
  cpm numeric,
  raw_payload jsonb,
  pulled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advertiser_id, campaign_id, item_group_id, vid, stat_date)
);
GRANT ALL ON public.gmv_max_vid_daily TO service_role;
ALTER TABLE public.gmv_max_vid_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.gmv_max_vid_daily FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER gmv_max_vid_daily_touch BEFORE UPDATE ON public.gmv_max_vid_daily
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX gmv_max_vid_daily_date_idx ON public.gmv_max_vid_daily(stat_date);
CREATE INDEX gmv_max_vid_daily_vid_idx ON public.gmv_max_vid_daily(vid);
CREATE INDEX gmv_max_vid_daily_adv_idx ON public.gmv_max_vid_daily(advertiser_id);

-- 5. add role to staff_sheets
ALTER TABLE public.staff_sheets
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'BD'
    CHECK (role IN ('BD','EDITOR'));
