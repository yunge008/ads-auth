# 完工日志（只追加，不修改历史行）

格式：`日期 | 工具 | 改了什么 | 涉及文件`

2026-06-10 | claude | 建立协同文档体系（AGENTS.md / CLAUDE.md / docs/） | AGENTS.md, CLAUDE.md, docs/*
2026-06-10 | lovable | 校准 PLAN：3 条历史任务标完成（默认 tab/日期、GMV Max cron job、索引） | docs/PLAN.md
2026-06-10 | lovable | 新增每日 08:00 自动授权 cron：authorize-cron 路由 + authorize_cron_state 表 + 飞书机器人通知；3 个 Edge Function 加 x-cron-key bypass | src/routes/api/public/hooks/authorize-cron.ts, supabase/migrations/*_authorize_cron_state.sql, supabase/functions/{feishu-read,authorize-batch,feishu-writeback}/index.ts, docs/ARCHITECTURE.md
2026-06-10 | lovable | feishu-read 改为固定列布局（G=VID / H=授权码 / I=SKU，删除 legacy G 列授权码分支）；执行授权页顶部加可折叠「📖 使用说明」（3 个 tab：操作流程/读取规则/回写规则） | supabase/functions/feishu-read/index.ts, src/routes/index.tsx
