# 完工日志（只追加，不修改历史行）

格式：`日期 | 工具 | 改了什么 | 涉及文件`

2026-06-10 | claude | 建立协同文档体系（AGENTS.md / CLAUDE.md / docs/） | AGENTS.md, CLAUDE.md, docs/*
2026-06-10 | lovable | 校准 PLAN：3 条历史任务标完成（默认 tab/日期、GMV Max cron job、索引） | docs/PLAN.md
2026-06-10 | lovable | 新增每日 08:00 自动授权 cron：authorize-cron 路由 + authorize_cron_state 表 + 飞书机器人通知；3 个 Edge Function 加 x-cron-key bypass | src/routes/api/public/hooks/authorize-cron.ts, supabase/migrations/*_authorize_cron_state.sql, supabase/functions/{feishu-read,authorize-batch,feishu-writeback}/index.ts, docs/ARCHITECTURE.md
2026-06-10 | lovable | feishu-read 改为固定列布局（G=VID / H=授权码 / I=SKU，删除 legacy G 列授权码分支）；执行授权页顶部加可折叠「📖 使用说明」（3 个 tab：操作流程/读取规则/回写规则） | supabase/functions/feishu-read/index.ts, src/routes/index.tsx
2026-06-26 | codex | 新增飞书表接入指南：面向新项目说明 Edge Function 读表/回写、secrets、鉴权、单元格解析和常见错误 | docs/FEISHU_SPREADSHEET_INTEGRATION.md, docs/PLAN.md, docs/WORKLOG.md
2026-07-05 | claude | 适配授权码表新列布局：sheet 改名「建联-姓名」（staff_sheets 迁移）；feishu-read 读 A2:W（Q=VID/R=授权码/J=SKU），移除首个非空投放日期行启发式，待办=V 列为空；feishu-writeback 回写 P/Q→V/W；feishu-read-bd-vids 同步改列；前端说明面板与文档更新 | supabase/functions/{feishu-read,feishu-writeback,feishu-read-bd-vids}/index.ts, supabase/migrations/20260705000000_rename_staff_sheets_jianlian.sql, src/routes/index.tsx, docs/{ARCHITECTURE,FEISHU_SPREADSHEET_INTEGRATION,PLAN}.md
2026-07-08 | claude | 建联表表头再次调整（27 列 A–AA）：feishu-read 改为 P=VID / Q=授权码 / K=SKU / N=视频登记日期，V/W 回写列不变；feishu-read-bd-vids 同步（读 A2:P）；feishu-writeback 无需改动；前端说明面板与文档更新 | supabase/functions/{feishu-read,feishu-read-bd-vids}/index.ts, src/routes/index.tsx, docs/{ARCHITECTURE,FEISHU_SPREADSHEET_INTEGRATION}.md
2026-07-06 | codex | 新增 TikTok BC VID 实时状态接口，直接调用 gmv_max/report/get 并返回原始 dimensions/metrics；抽取共享 ttGet 限速重试客户端 | supabase/functions/{_shared/tiktok.ts,gmv-max-sync/index.ts,gmv-max-live-status/index.ts}, docs/{ARCHITECTURE,PLAN,WORKLOG}.md
2026-07-06 | codex | 修复 TikTok BC VID 实时状态接口 Invalid metrics：移除 item 维度不支持的 3 个静态素材指标，保留投放状态及成效指标 | supabase/functions/gmv-max-live-status/index.ts, docs/{PLAN,WORKLOG}.md
