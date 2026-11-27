# CLAUDE.md

本项目协作规则、架构、任务板统一维护在：

- @AGENTS.md — 协同开发规则（必读）
- @docs/ROADMAP.md — 按功能线的待办总览（负责人看这份；每次完工同步更新对应功能线）
- docs/ARCHITECTURE.md — 架构说明
- docs/PLAN.md — 计划与任务认领
- docs/WORKLOG.md — 完工日志（只追加）

开工前先 `git pull` 并读 PLAN.md 认领任务；完工后更新 PLAN/WORKLOG 并 push。

开工时另跑 `bash tools/check-deploy.sh`，核对上一次要求负责人做的 Edge Function 部署是否已落实（负责人 2026-11-23 要求），未落实的先告诉负责人。

凡新增/修改 TikTok Shop、TikTok Business（BC）等外部接口调用或新增定时任务：先读 docs/API_RATE_LIMITS.md，跑 `bash tools/check-api-limits.sh`（有未登记接口会返回非 0），补登记表与定时任务时间线，按 §6 核对是否超速、失败是否会静默（负责人 2026-11-27 要求）。限速冲突一律**错开调用时间**解决（改新任务或冲突任务的执行时间，时间写新加坡时间），不加锁。
