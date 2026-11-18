-- SEA 库存监控（左侧 TAB「SEA库存监控」，tab key = sea-inventory）
-- 2026-11-18 合并：原 20261117190000_sea_inventory.sql + 20261117200000_sea_inventory_qianyi_refs.sql（均未执行）+ 云盘导入列，一次执行即可
--   sea_inv_settings     全局参数（单行 id=1）
--   sea_inv_warehouses   实体仓：千易 MY/PH、顶妙 TH1、BigSeller VN、泰国新仓、国内仓；links = 绑定的 TikTok 仓库（每店一个 warehouse_id）
--   sea_inv_wh_stock     海外仓 SKU 可用库存快照（API 同步或页面手动导入）
--   sea_inv_shop_sync    每个店铺 listing/订单同步状态
--   sea_inv_slots        listing 槽位快照：店铺 × SKU × TikTok 仓库 的当前可售 + 窗口销量
--   sea_inv_sku_map      listing SKU ↔ 仓库 SKU 映射表（每晚刷新、记变化；可人工覆盖）
--   sea_inv_plans / sea_inv_plan_items   调整计划与明细（用户勾选确认后经 API 执行，逐条记结果）

CREATE TABLE IF NOT EXISTS public.sea_inv_settings (
  id               int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  window_days      int     NOT NULL DEFAULT 14 CHECK (window_days BETWEEN 1 AND 60),
  min_days         numeric NOT NULL DEFAULT 10 CHECK (min_days > 0),
  min_qty          int     NOT NULL DEFAULT 5  CHECK (min_qty >= 0),
  reserve_per_sku  int     NOT NULL DEFAULT 5  CHECK (reserve_per_sku >= 0),
  zero_sale_qty    int     NOT NULL DEFAULT 5  CHECK (zero_sale_qty >= 0),
  cn_min_days      numeric NOT NULL DEFAULT 10 CHECK (cn_min_days > 0),
  cn_target_days   numeric NOT NULL DEFAULT 20 CHECK (cn_target_days > 0),
  stock_max_age_hours int  NOT NULL DEFAULT 26 CHECK (stock_max_age_hours > 0),
  last_run_at      timestamptz,
  last_run_summary jsonb,
  map_refreshed_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.sea_inv_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sea_inv_warehouses (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('qianyi','dingmiao','bigseller','manual','tiktok')),
  kind        text NOT NULL CHECK (kind IN ('overseas','cn')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','onboarding','phasing_out','disabled')),
  region      text,
  links       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{shop_id, tts_warehouse_id}]
  provider_ref text,                               -- 仓库系统里的仓库：千易=仓库名称，顶妙=warehouseId
  note        text,
  sort        int NOT NULL DEFAULT 0,
  stock_synced_at timestamptz,
  stock_source    text,
  stock_rows      int,
  stock_error     text,
  drive_folder       text,                         -- 云盘文件夹链接或 ID（RPA 每天导出库存 Excel 放这里；填了就优先从云盘取）
  drive_name_pattern text,                         -- 文件名需包含的文字（空 = 文件夹里最新的表格文件）
  file_config        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {sheet, sku_col, avail_col, onhand_col, name_col, warehouse_col, warehouse_value}
  stock_file_name    text,
  stock_file_id      text,
  stock_file_modified timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.sea_inv_warehouses (code, name, provider, kind, status, region, sort, provider_ref, note) VALUES
  ('QY-MY',  '千易 MY 海外仓',        'qianyi',    'overseas', 'active',      'MY', 10, 'ARTPHRO-MY', '千易 ERP 海外站（asia.qianyierp.com），仓库「ARTPHRO-MY」'),
  ('QY-PH',  '千易 PH 海外仓',        'qianyi',    'overseas', 'active',      'PH', 20, 'ARTPHRO.PH', '千易 ERP 海外站（asia.qianyierp.com），仓库「ARTPHRO.PH」'),
  ('DM-TH1', '顶妙WMS TH 海外仓1',    'dingmiao',  'overseas', 'phasing_out', 'TH', 30, '147',        'TOPWMS gogo.topwms.com，仓库 147（TH001 GOGO云仓）；逐步退出，库存转移到泰国新仓'),
  ('TH-NEW', '泰国新仓（待定）',       'manual',    'overseas', 'disabled',    'TH', 40, NULL,         '新仓系统待定；启用时状态改「新仓接入中」'),
  ('BS-VN',  'BigSeller VN 海外仓',   'bigseller', 'overseas', 'active',      'VN', 50, NULL,         'BigSeller API 收费：RPA 每天导出库存 Excel 到云盘文件夹，系统自动读取；也可页面手动导入'),
  ('CN',     '国内仓',                'tiktok',    'cn',       'active',      NULL, 90, NULL,         '实物库存未接入，只按销量补 TikTok 库存，执行前人工确认')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sea_inv_wh_stock (
  warehouse_code text NOT NULL REFERENCES public.sea_inv_warehouses(code) ON DELETE CASCADE,
  wh_sku         text NOT NULL,
  available      int  NOT NULL,
  on_hand        int,
  product_name   text,
  source         text NOT NULL DEFAULT 'manual',   -- api / drive / manual
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_code, wh_sku)
);

CREATE TABLE IF NOT EXISTS public.sea_inv_shop_sync (
  shop_id        text PRIMARY KEY,
  listings_at    timestamptz,
  orders_at      timestamptz,
  orders_from    timestamptz,
  orders_count   int,
  slots_count    int,
  error          text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sea_inv_slots (
  shop_id          text NOT NULL,
  sku_id           text NOT NULL,
  tts_warehouse_id text NOT NULL,
  product_id       text NOT NULL,
  region           text,
  seller_sku       text NOT NULL DEFAULT '',
  title            text,
  qty              int  NOT NULL DEFAULT 0,
  committed        int  NOT NULL DEFAULT 0,
  sold             int  NOT NULL DEFAULT 0,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, sku_id, tts_warehouse_id)
);
CREATE INDEX IF NOT EXISTS sea_inv_slots_sku ON public.sea_inv_slots (seller_sku);

CREATE TABLE IF NOT EXISTS public.sea_inv_sku_map (
  shop_id          text NOT NULL,
  sku_id           text NOT NULL,
  product_id       text NOT NULL,
  seller_sku       text NOT NULL DEFAULT '',
  wh_sku_override  text,           -- 人工指定的仓库 SKU（seller_sku 与仓库编码不一致时用）
  prev_seller_sku  text,
  active           boolean NOT NULL DEFAULT true,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  changed_at       timestamptz,
  PRIMARY KEY (shop_id, sku_id)
);

CREATE TABLE IF NOT EXISTS public.sea_inv_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'MANUAL',     -- CRON / MANUAL
  created_by   text,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTING','DONE','PARTIAL','FAILED','SUPERSEDED')),
  params       jsonb,
  summary      jsonb,
  map_diff     jsonb,
  data_warnings jsonb,
  executed_at  timestamptz,
  executed_by  text
);
CREATE INDEX IF NOT EXISTS sea_inv_plans_created ON public.sea_inv_plans (created_at DESC);

CREATE TABLE IF NOT EXISTS public.sea_inv_plan_items (
  id               bigserial PRIMARY KEY,
  plan_id          uuid NOT NULL REFERENCES public.sea_inv_plans(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('overseas','cn')),
  warehouse_code   text NOT NULL,
  wh_sku           text NOT NULL,
  shop_id          text NOT NULL,
  region           text,
  product_id       text NOT NULL,
  sku_id           text NOT NULL,
  seller_sku       text,
  title            text,
  tts_warehouse_id text NOT NULL,
  current_qty      int  NOT NULL,
  proposed_qty     int  NOT NULL,
  daily_sales      numeric,
  days_before      numeric,
  days_after       numeric,
  wh_available     int,
  pool             int,
  reason           text,
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  new_link         boolean NOT NULL DEFAULT false,
  selected         boolean NOT NULL DEFAULT true,
  final_qty        int,            -- 用户在页面改过的数量（null = 用 proposed_qty）
  live_qty         int,            -- 执行前实时读到的 TikTok 可售
  exec_qty         int,
  exec_status      text NOT NULL DEFAULT 'PENDING' CHECK (exec_status IN ('PENDING','OK','FAILED','SKIPPED')),
  exec_message     text,
  exec_at          timestamptz
);
CREATE INDEX IF NOT EXISTS sea_inv_plan_items_plan ON public.sea_inv_plan_items (plan_id, kind);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sea_inv_settings','sea_inv_warehouses','sea_inv_wh_stock','sea_inv_shop_sync','sea_inv_slots','sea_inv_sku_map','sea_inv_plans','sea_inv_plan_items'] LOOP
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "service role only" ON public.%I', t);
    EXECUTE format('CREATE POLICY "service role only" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.sea_inv_plan_items_id_seq TO service_role;

-- 每天两次 → /api/public/hooks/sea-inventory-cron
--   北京 09:10（UTC 01:10）白天档；北京 21:10（UTC 13:10）夜间档，夜间档同时刷新映射表并比对变化
-- 域名与 apikey 从已有 hook 类 cron job 命令里抄（同 20261109120000_balance_alert.sql）
DO $$
DECLARE
  _src text; _base text; _key text;
BEGIN
  SELECT command INTO _src FROM cron.job WHERE command LIKE '%/api/public/hooks/%' LIMIT 1;
  IF _src IS NULL THEN
    RAISE WARNING '找不到任何 /api/public/hooks/ 的 cron job，请手动 cron.schedule 建立 sea-inventory-day / sea-inventory-night';
    RETURN;
  END IF;
  _base := substring(_src from 'https?://[^/]+');
  _key  := substring(_src from '"apikey"\s*:\s*"([^"]+)"');
  IF _base IS NULL OR _key IS NULL THEN
    RAISE WARNING '无法解析域名或 apikey，请手动 cron.schedule';
    RETURN;
  END IF;
  PERFORM cron.unschedule(j) FROM unnest(ARRAY['sea-inventory-day','sea-inventory-night']) j
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = j);
  PERFORM cron.schedule('sea-inventory-day', '10 1 * * *', format(
    $cmd$select net.http_post(url := %L, headers := %L::jsonb, body := '{"slot":"day"}'::jsonb, timeout_milliseconds := 600000);$cmd$,
    _base || '/api/public/hooks/sea-inventory-cron',
    json_build_object('Content-Type', 'application/json', 'apikey', _key)::text));
  PERFORM cron.schedule('sea-inventory-night', '10 13 * * *', format(
    $cmd$select net.http_post(url := %L, headers := %L::jsonb, body := '{"slot":"night"}'::jsonb, timeout_milliseconds := 600000);$cmd$,
    _base || '/api/public/hooks/sea-inventory-cron',
    json_build_object('Content-Type', 'application/json', 'apikey', _key)::text));
  RAISE NOTICE 'sea-inventory-day 10 1 * * * (北京 09:10) / sea-inventory-night 10 13 * * * (北京 21:10) scheduled';
END;
$$;
