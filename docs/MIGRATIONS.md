# 已执行 migration 台账

**为什么有这个文件**：本项目的 migration 由人工在 `Supabase Dashboard → SQL Editor` 里执行，
跑完的文件会从 `supabase/migrations/` 删掉，避免下次误跑。文件删了，"这条到底跑没跑、
什么时候跑的、干了什么" 就没有记录了 —— 这张表就是那份记录。

**规则**：
- 用户说 "xxx 跑了" → 在这里追加一行（**只追加，不修改历史行**），然后从 `supabase/migrations/` 删掉该文件。
- 没确认跑过的，文件留在 `supabase/migrations/` 里，不进这张表。
- 表里已有的行 = 数据库里已经生效的结构，查 "某个视图/RPC 当初怎么定义的" 看这里对应的提交。

**要看 SQL 原文**：文件虽然删了，git 历史里永远还在。按下表的「引入提交」查：

```bash
git show <提交号>:supabase/migrations/<文件名>
```

| 执行日期 | 文件名 | 引入提交 | 干了什么 |
| --- | --- | --- | --- |
| 2026-09-18 | `20260916140000_attribution_v3_fact_tables.sql` | `f2fe884` | V3 事实层：归因事实表、`attribution_manual_rules`（VID 级人工强归因）、`attribution_manual_decisions`（人工达人判定） |
| 2026-09-18 | `20260916140100_attribution_v3_identity_stages.sql` | `f2fe884` | V3 身份层 + 归属区间层建表（含区间不重叠的排他约束） |
| 2026-09-18 | `20260916160000_protection_90d_consistency.sql` | `282d241` | 保护期统一 90 自然天；SQL 第二实现 `attribution_protection_owner_90d` + 校验视图 `attribution_protection_check_90d` |
| 2026-09-18 | `20260917120000_registry_audit_views.sql` | `61802c8` | 登记盘点视图（按 sheet／按 BD 的登记行数与日期分布） |
| 2026-09-18 | `20260918110000_needs_posted_at_exact_again.sql` | `7bbcac9` | `attribution_norm_creative_type` 收成精确匹配（撤回包含式匹配），与 TS 两处归一化对齐 |
| 2026-09-18 | `20260918140000_attribution_lookup.sql` | `42dfa98` | 归因查询 RPC `attribution_lookup`（VID／昵称 → 每月归给谁），返回单 JSON 规避 PostgREST 1000 行截断 |
| 2026-09-18 | `20260918160000_protection_no_date_rows.sql` | `6c520d1` | A4：无日期的登记行不参与归属判定，SQL 侧与 TS 的 `resolveOwnership` 对齐 |
| 2026-09-18 | `20260918170000_feishu_sheet_config.sql` | `fa8b620` | 新表 `feishu_sheet_config`（飞书表名配置，8 行初始数据），去掉 sheet 别名兜底 |
| 2026-10-13 | `20261012130000_purge_gmv_max_storage.sql` | `953a41a` | 停 GMV Max pg_cron（unschedule 3 个 job）+ TRUNCATE `gmv_max_vid_daily`/`gmv_max_vid_meta`（之后被手动同步又写入 537 行，由 20261013090000 再清） |
| 2026-11-10 | `20261105120000_tts_shops.sql` | `9a3f93b` | 联盟达人外联：新表 `tts_shops`（TikTok Shop 店铺授权，RLS 开、无 policy） |
| 2026-11-18 | `20261118120000_sea_inventory.sql` | `96e7099` | SEA库存监控：8 张表（sea_inv_*，RLS 仅 service role）+ 6 个预置仓库（千易 MY/PH、顶妙 TH1、泰国新仓、BigSeller VN、国内仓）+ pg_cron `sea-inventory-day`（北京 09:10）/ `sea-inventory-night`（北京 21:10） |
| 2026-11-18 | `20261118150000_sea_inventory_file_wh_names.sql` | `68a0637` | SEA库存监控：各仓导出文件仓库名（file_config.warehouse_value）；TH-NEW 改 BigSeller「AR thailand 泰国」 |
| 2026-11-19 | `20261118210000_sea_inventory_sales_daily.sql` | `331fa0f` | SEA库存监控：新表 `sea_inv_sales_daily`（店铺 × SKU ID × 仓库 × 本地日 的件数，保留 60 天，RLS 仅 service role）+ `sea_inv_shop_sync.sales_synced_day` |
| 2026-11-19 | `20261118230000_sea_inventory_target_days.sql` | `d96a401` | SEA库存监控：`sea_inv_settings.target_days`（补到目标天数，默认 30） |
| ≤2026-11-24 | `20261117120000_outreach_core.sql` | `538dbce` | 达人建联核心 5 表（outreach_touches / creator_state / creator_events / conflicts / settings）。执行日未记录，2026-11-24 检查 SQL 确认已存在 |
| ≤2026-11-24 | `20261123120000_tts_multi_app.sql` | `538dbce` | TikTok Shop 多应用：`tts_apps` + `tts_shops.app_code` + pg_cron `tts-token-refresh`。同上确认 |
| ≤2026-11-24 | `20261123130000_outreach_settings_rls.sql` | `538dbce` | `outreach_settings` 开 RLS。同上确认 |
| ≤2026-11-24 | `20261124120000_gmv_max_import_logs.sql` | `b82e5cf` | GMV Max 导入记录表 `gmv_max_import_logs`。同上确认 |
| ≤2026-11-24 | `20261124130000_gmv_max_import_logs_src_dst.sql` | `aedd688` | 导入记录加来源/去向户名与 BC 6 列。同上确认 |
| 2026-11-24 | `20261124150000_ai_readonly.sql` | `059b319` | AI 只读通道 v1：角色 ai_reader、按列授权、RLS 只读策略（834 列 / 61 策略 / 屏蔽 10 列） |
| 2026-11-24 | `20261124160000_ai_readonly_direct.sql` | `e8dc6ac` | AI 只读通道 v2：ai_key_ok / ai_db_query / ai_db_refresh_grants，删 ai_readonly_query |
| 2026-11-25 | `20261125120000_tts_daily_sync.sql` | `48d14c3` | 订单/财务每日入库 4 表 + tts_shops.daily_sync（PH/TH）+ pg_cron tts-daily-sync；授权后 867 列 |
| 2026-11-25 | `20261125130000_db_size_monitor.sql` | `cb8cba2` | 只读函数 db_size_bytes()（仅 service_role），供 tts-sync-cron 空间 80% 告警 |
