-- 飞书表名配置：补齐剩下几处「代码在读写飞书、但配置表里看不到」的位置，并放开 sheet 名留空。
--
-- 上一版（20260918170000）只收了归因链路上的 8 张。但 docs/FEISHU_SPREADSHEET_INTEGRATION.md
-- 那张函数清单里还有几个函数也在动飞书：授权读表 / 授权回写 / SKU 匹配表。
-- 这张配置表的意义就是「一眼看全系统动了飞书哪些地方」，漏一处就等于这张表不能信 ——
-- 出问题时还是得回去翻代码，那还不如没有。所以这里按函数把剩下的位置逐条补进来。
--
-- 同一张 sheet 被多个函数读时，本表按「函数用途」分行而不是按 sheet 去重：
-- 建联-{姓名} 这张 sheet 就有归因同步、发样统计、授权读表、BD VID 校验四个入口，
-- 读的列范围和会不会回写都不一样，合成一行反而看不出「授权流程会写 V/W 列」这种要命的差别。

-- sheet 名允许留空 = 这张表还没提供给系统。留空的行不参与匹配（enabled = false），
-- 配好名称并启用后才会生效。以前的 NOT NULL 只拦 NULL 不拦 '', 这里用注释说清楚语义。
COMMENT ON COLUMN public.feishu_sheet_config.sheet_name IS
  'sheet 名称，按去空白后精确匹配。留空 = 还没提供给系统，应同时 enabled = false。';
COMMENT ON COLUMN public.feishu_sheet_config.read_range IS
  '读取范围，由解析代码写死，界面上只读展示。改列范围必须同时改代码。';

INSERT INTO public.feishu_sheet_config
  (config_key, spreadsheet_label, spreadsheet_env, sheet_name, read_range, access, note, column_map, sort_order, enabled) VALUES
('AUTH_READ', '达人建联主表格', '', '建联-{同事姓名}', 'A2:W', 'READWRITE',
 '执行授权流程（feishu-read）读的也是各 BD 的建联 sheet，比归因同步多读到 W 列。授权结果由 feishu-writeback 写回 V（投放日期）/ W（状态）两列 —— 这两列人工手填会被覆盖。',
 '[{"col":"C","field":"country","note":"国家/站点"},
   {"col":"D","field":"handle","note":"用户名"},
   {"col":"K","field":"registered_sku","note":"SKU"},
   {"col":"N","field":"register_date","note":"视频登记日期"},
   {"col":"P","field":"vid","note":"VID，必须是文本格式"},
   {"col":"Q","field":"auth_code","note":"授权码"},
   {"col":"V","field":"launch_date","note":"投放日期（系统回写）"},
   {"col":"W","field":"status","note":"授权状态（系统回写）"}]'::jsonb, 15, true),
('AUTH_LOG', '达人建联主表格', '', '授权记录', 'A2:I', 'READWRITE',
 '授权回写日志（feishu-writeback）按行追加/更新。与 ARCHIVE 是同一张 sheet：ARCHIVE 是归因同步只读 M:S 段的历史登记，这里是授权流程写的 A:I 段。',
 '[{"col":"A:I","field":"-","note":"授权日志行，由 feishu-writeback 追加或按行号更新；列位见该函数源码"}]'::jsonb, 25, true),
('SKU', 'SKU 匹配表格', 'FEISHU_SKU_SPREADSHEET_TOKEN', 'SKU匹配表', 'A2:F', 'READ',
 '商品 SKU 映射（feishu-read-sku），按 country + product_id + merchant_sku 去重后 upsert。不参与归因判定，只用于把 GMV MAX 的商品 ID 翻成看得懂的名字。',
 '[{"col":"A","field":"country","note":"国家/站点"},
   {"col":"B","field":"product_id","note":"商品 ID"},
   {"col":"C","field":"product_name","note":"商品名称"},
   {"col":"D","field":"sku_id","note":"SKU ID"},
   {"col":"E","field":"merchant_sku","note":"商家 SKU"},
   {"col":"F","field":"note","note":"备注"}]'::jsonb, 90, true),
-- 名称留空 = 还没提供给系统。先把位置占住，免得「这事到底配了没」每次都要重新问一遍。
('MANUAL_OVERRIDE', '', '', '', '待定', 'READ',
 '【待提供】人工最高优先级覆盖表。目前人工覆盖走「审查与回写 → 导出/导入 Excel」入库，不读飞书。如果要改成从飞书某张表直接读，把表格与 sheet 名填进来并启用 —— 但代码尚未接入，填了也要等接入后才生效。',
 '[]'::jsonb, 100, false)
ON CONFLICT (config_key) DO NOTHING;

-- 顺手把两条「还有别的函数在读同一张 sheet」的事实写进备注，省得看的人以为只有一个入口。
UPDATE public.feishu_sheet_config
SET note = note || ' 另：feishu-read-bd-vids 也读这张 sheet 做 BD VID 校验（P=VID / K=SKU）。'
WHERE config_key = 'JIANLIAN' AND note NOT LIKE '%feishu-read-bd-vids%';

UPDATE public.feishu_sheet_config
SET note = note || ' 另：feishu-read-editors 也读这批 sheet 做剪辑 VID 入库。'
WHERE config_key = 'EDITOR' AND note NOT LIKE '%feishu-read-editors%';

-- 同一张 sheet 的几行排在一起：建联-{同事姓名} 有归因同步(10)、授权读表(15)、发样统计三个入口，
-- 发样统计原来排 80，被别的 sheet 隔开了，看的人容易漏掉「这张 sheet 其实有三个读取入口」。
UPDATE public.feishu_sheet_config SET sort_order = 18 WHERE config_key = 'CONNECTION_STATS';
