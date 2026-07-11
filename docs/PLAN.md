# 计划与任务板

> 规则：开工先认领（填工具名+日期+涉及文件），状态：⬜待办 / 🔶进行中 / ✅完成。
> 完成后把任务移到底部「已完成」区，并在 WORKLOG.md 追加一行。

## 当前计划

1. **自动授权**：每天北京 08:00 pg_cron → `/api/public/hooks/authorize-cron` → 循环执行授权 → 飞书机器人通知（已完成）
2. **GMV Max 性能优化**：短期索引已落库 ✅；中期 rollup 表、远期月分区待数据再上量后评估
3. **前端「上次自动刷新时间」UI**：展示 `gmv_max_sync_state` 最近运行时间（未做）

## 任务板

| 任务 | 状态 | 认领 | 涉及文件 | 备注 |
| --- | --- | --- | --- | --- |
| GMV 归因进度（按审核计划重构） | 🔶 进行中 | codex 2026-07-11 | docs/GMV_ATTRIBUTION_REVIEW_PLAN.md、supabase/migrations/、supabase/functions/attribution-*、supabase/functions/_shared/{attribution,attribution-report}.ts、src/routes/gmv-attribution*.tsx、src/components/attribution/*、src/lib/{attributionApi,adExcel,tabs}.ts、src/routes/settings.tsx | 已接管既有原型，按审核计划实施阶段 1-4：站点维度身份键、目标组与汇率、计算批次及明细、飞书四张新表、全量导出、同事页阈值展示及刷新调度。飞书已建「绩效配置表 / 归因审查 / 绩效统计记录 / 归因记录」；待补齐统计记录的 4 个目标组派生列与审查的判定时间列。 |
| 前端显示「上次自动刷新时间」 | ⬜ | — | src/routes/feishu-data.tsx | 读 gmv_max_sync_state（cron_yesterday / cron_today） |

## 进行中文件锁（防交叉修改）

| 文件 | 谁在改 | 开始时间 |
| --- | --- | --- |
| supabase/functions/attribution-*、supabase/functions/_shared/{cells,attribution,attribution-report}.ts、src/routes/gmv-attribution*.tsx、src/components/attribution/* | codex | 2026-07-11 |

## 已完成

- ✅ 2026-07-09 [claude] 修复自动授权静默失败（成功0/失败0/无授权账号0）：`authorize-batch` 补 `x-cron-key` 放行（此前 cron 调用被 401 拒绝）；`authorize-log` RPC 参数名对齐 `_key`；corsHeaders 加 `x-cron-key`；cron 飞书通知附带错误摘要。**待人工**：重新部署 `authorize-batch`、`authorize-log` 两个 Edge Function（authorize-cron 路由随 Lovable 前端自动部署）

- ✅ 2026-07-06 [codex] 修复 `gmv-max-live-status`：移除当前报表维度不支持的 `tt_account_name`、`tt_account_authorization_type`、`shop_content_type`

- ✅ 2026-07-06 [codex] 新增 `gmv-max-live-status`，按广告户、Campaign、商品和 VID 直接查询 TikTok BC；抽取共享 `ttGet` 限速重试客户端，不读取或写入 GMV 明细表

- ✅ 2026-06-10 [claude] 建立协同文档体系
- ✅ 2026-06-10 [lovable] feishu-data 默认 tab=gmv、日期=昨天（已合入）
- ✅ 2026-06-10 [lovable] pg_cron 两条 GMV Max job 写入（gmv-max-sync-yesterday / today-hourly）
- ✅ 2026-06-10 [lovable] gmv_max_vid_daily 加 4 条索引（country+stat_date / advertiser_id+stat_date / vid / stat_date BRIN）
- ✅ 2026-06-10 [lovable] 每日 08:00 自动授权 cron：新 authorize-cron 路由 + authorize_cron_state 表 + 飞书机器人通知 + 3 个 Edge Function 加 x-cron-key bypass + pg_cron job authorize-daily-0800
- ✅ 2026-06-10 [lovable] feishu-read 固定列布局 + 执行授权页可折叠使用说明
- ✅ 2026-06-26 [codex] 新增飞书表接入指南文档，说明新项目读表、回写、鉴权、secrets 和常见错误
- ✅ 2026-07-05 [claude] 适配授权码表新列布局（sheet 改名建联-姓名；Q=VID / R=授权码 / J=SKU；回写改 V/W 列；staff_sheets 改名迁移）。**待人工**：① 在 5 张建联表 U 列后加 V=投放日期、W=回写状态表头 ② 部署 3 个 Edge Function + 跑迁移 ③ 小范围验证读取/回写
