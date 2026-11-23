# CLAUDE.md

本项目协作规则、架构、任务板统一维护在：

- @AGENTS.md — 协同开发规则（必读）
- docs/ARCHITECTURE.md — 架构说明
- docs/PLAN.md — 计划与任务认领
- docs/WORKLOG.md — 完工日志（只追加）

开工前先 `git pull` 并读 PLAN.md 认领任务；完工后更新 PLAN/WORKLOG 并 push。

开工时另跑 `bash tools/check-deploy.sh`，核对上一次要求负责人做的 Edge Function 部署是否已落实（负责人 2026-11-23 要求），未落实的先告诉负责人。
