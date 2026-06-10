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
| 前端显示「上次自动刷新时间」 | ⬜ | — | src/routes/feishu-data.tsx | 读 gmv_max_sync_state（cron_yesterday / cron_today） |

## 进行中文件锁（防交叉修改）

| 文件 | 谁在改 | 开始时间 |
| --- | --- | --- |
| （空） | | |

## 已完成

- ✅ 2026-06-10 [claude] 建立协同文档体系
- ✅ 2026-06-10 [lovable] feishu-data 默认 tab=gmv、日期=昨天（已合入）
- ✅ 2026-06-10 [lovable] pg_cron 两条 GMV Max job 写入（gmv-max-sync-yesterday / today-hourly）
- ✅ 2026-06-10 [lovable] gmv_max_vid_daily 加 4 条索引（country+stat_date / advertiser_id+stat_date / vid / stat_date BRIN）
- ✅ 2026-06-10 [lovable] 每日 08:00 自动授权 cron：新 authorize-cron 路由 + authorize_cron_state 表 + 飞书机器人通知 + 3 个 Edge Function 加 x-cron-key bypass + pg_cron job authorize-daily-0800
- ✅ 2026-06-10 [lovable] feishu-read 固定列布局 + 执行授权页可折叠使用说明
