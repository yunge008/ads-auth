# 计划与任务板

> 规则：开工先认领（填工具名+日期+涉及文件），状态：⬜待办 / 🔶进行中 / ✅完成。
> 完成后把任务移到底部「已完成」区，并在 WORKLOG.md 追加一行。

## 当前计划（来自 .lovable/plan.md，2026-06 制定）

1. **feishu-data 页默认行为**：默认 tab 改 GMV Max，日期默认昨天
2. **GMV Max 自动调度**：cron 路由已建（`src/routes/api/public/hooks/gmv-max-cron.ts`），待确认 pg_cron job 是否已写入（yesterday 03:00 + today 每小时，UTC+8）
3. **查询性能优化**：短期加 4 条索引（country+stat_date / advertiser_id+stat_date / vid / stat_date BRIN）；中期 rollup 表；远期按月分区

## 任务板

| 任务 | 状态 | 认领 | 涉及文件 | 备注 |
| --- | --- | --- | --- | --- |
| feishu-data 默认 tab=gmv、日期=昨天 | ⬜ | — | src/routes/feishu-data.tsx | |
| 确认/写入 pg_cron 两条 job | ⬜ | — | （Supabase SQL，不入 migration） | 需 UTC 换算 |
| gmv_max_vid_daily 加索引 migration | ⬜ | — | supabase/migrations/ | 只加索引不动业务代码 |
| 前端显示「上次自动刷新时间」 | ⬜ | — | src/routes/feishu-data.tsx | 读 gmv_max_sync_state |

## 进行中文件锁（防交叉修改）

| 文件 | 谁在改 | 开始时间 |
| --- | --- | --- |
| （空） | | |

## 已完成

- ✅ 2026-06-10 [claude] 建立协同文档体系
