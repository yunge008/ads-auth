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
| GMV Max 原始导出 + 多国广告表归因验证 | 🔶 进行中 | codex 2026-07-13 | supabase/functions/gmv-max-raw-export/index.ts、src/routes/api-test.tsx、docs/{ARCHITECTURE,PLAN,WORKLOG}.md、src/components/attribution/UploadView.tsx（仅验证） | 新增独立、只读的 GMV Max CSV 导出 Function，按广告户与日期范围拉取；不改变 gmv-max-sync。优先验证同月多国家多 Excel 上传、归因及合并展示。 |
| 前端显示「上次自动刷新时间」 | ⬜ | — | src/routes/feishu-data.tsx | 读 gmv_max_sync_state（cron_yesterday / cron_today） |
| GMV Max 广告组新建 API | ✅ 完成（已部署 2026-08-19 lovable） | claude 2026-08-19 | supabase/functions/gmv-max-adgroup-create/index.ts、supabase/functions/_shared/tiktok.ts、src/routes/api-test.tsx | TikTok GMV Max 无独立 campaign/adgroup/ad 三层，新建广告组即调用 `/campaign/gmv_max/create/`（含预算/商品/出价，等价于把广告组打包进 campaign）。新函数只做鉴权+按 advertiser_id 查 token+透传 POST，不校验/拼装业务字段，需在 API 测试页命令框手填完整 TikTok GmvMaxCreateBody JSON（含 request_id 保证幂等）。真实写调用，会产生真实花费，测试前确认参数。新增 `_shared/tiktok.ts` 的 `ttPost`（同 `ttGet` 限速/退避）。 |
| GMV MAX新建页面（表单+Excel批量） | ✅ 完成（已部署 2026-08-25 lovable） | claude 2026-08-25 | src/routes/gmv-max-create.tsx、src/lib/tabs.ts、supabase/functions/gmv-max-adgroup-batch-create/index.ts、supabase/functions/_shared/gmv-max-adgroup.ts、supabase/functions/gmv-max-adgroup-create/index.ts（重构复用共享逻辑）、supabase/functions/{tiktok-oauth-exchange,tiktok-connection-save,tiktok-connections}/index.ts、src/routes/oauth.tiktok.callback.tsx、src/lib/store.ts、src/components/settings/AccountsTable.tsx、supabase/migrations/20260825120000_tiktok_connections_bc_name.sql | 新 tab「GMV MAX新建」（放在素材成效下、GMV归因上）。页面：①单个新建表单——广告户下拉（自动读 store_id/BC ID，缺失会提示去设置页补）、广告组名称、商品ID多行文本框、ROI、预算、开始/结束时间（datetime-local，默认马上开始/不设结束）；②Excel 批量新建——同一套字段的表格上传（含"下载模板"按钮），前端用 xlsx 解析、校验后调同一个批量接口。新 Edge Function `gmv-max-adgroup-batch-create` 接受结构化 `{rows:[...]}`，自动从 `advertiser_countries.shop_id`/`tiktok_connections.bc_id` 取 store_id/store_authorized_bc_id，固定其余字段（PRODUCT/CUSTOMIZED_PRODUCTS/VALUE/VO_MIN_ROAS/AUTO_SELECTION），逐行创建、单行失败不影响其余行。抽出 `_shared/gmv-max-adgroup.ts`（`findConnectionsForAdvertiser`/`createGmvMaxCampaign`/`genRequestId`）给这个新函数和原 `gmv-max-adgroup-create` 共用。顺带在设置页「TikTok 授权连接」表加 BC 名称/BC ID 两列（`tiktok_connections` 新增 `bc_name` 列，`tiktok-oauth-exchange` 授权时顺带查 `/bc/get/` 拿名称）。① 迁移、② 五个 Edge Function 部署已于 2026-08-25 由 lovable 完成。**待人工**：③ 有权限的账号需要在账号管理里给自己加 `gmv-max-create` tab 权限才能看到新 tab（管理员账号不受限）④ 真实写调用，首次用小额预算/短时间验证后再放量。 |

## 进行中文件锁（防交叉修改）

| 文件 | 谁在改 | 开始时间 |
| --- | --- | --- |
| supabase/functions/attribution-*、supabase/functions/_shared/{cells,attribution,attribution-report}.ts、src/routes/gmv-attribution*.tsx、src/components/attribution/* | codex | 2026-07-11 |

## 已完成

- ✅ 2026-08-26 [claude] GMV MAX新建页面 · 「单个新建」/「Excel 批量新建」两张卡片改左右并排（`grid lg:grid-cols-2 items-stretch`，两卡整体高度保持一致）；单个新建内部布局改回：广告户/广告组名称同一行，下方商品ID文本框与 ROI/预算/开始时间/结束时间 4 项左右并排（flex + `items-stretch` + 商品ID 用 `flex-1` 自适应高度，下边缘自动跟结束时间框对齐，不用硬编码像素）；商品ID提示语「（一行一个，也支持用逗号分隔，中英文逗号均可，框内自动换行）」拆到独立第二行显示，不与「商品ID」共一行挤压换行。仅布局调整，未改校验/提交逻辑。 | src/routes/gmv-max-create.tsx, src/lib/version.ts | 不需要做任何事，Lovable 同步 main 自动生效。

- ✅ 2026-08-26 [claude] GMV MAX新建页面 · Excel 批量新建交互优化：①「下载模板」右侧改为「上传文件」按钮（隐藏 input + 触发点击，样式同「下载模板」），不再用原生文件选择框；②上传后直接在模板正下方渲染预览表格（含每行商品ID/ROI/预算/时间等全部字段），不用等点「批量创建」才能看到内容；③点「执行创建」后改为逐行串行调用 `gmv-max-adgroup-batch-create`（每次只传 1 行），每行状态在表格里实时刷新为「创建中…→成功/失败」，校验不通过的行直接标「校验未通过」并跳过调用，不再要求整批先修完校验错误才能提交；④结果表格支持「下载结果」导出为 xlsx（含状态列 + CampaignID/错误原因列）；⑤下载模板生成逻辑改为对 A:C（广告户ID/广告组名称/商品ID）列预设文本格式（`z:"@"`，避免大数字 ID 被 Excel 转科学计数法），F:G（开始/结束时间）列预设 `yyyy-mm-dd hh:mm:ss` 日期时间格式，预格式化到 200 行（对齐批量接口单次上限），后续在模板里继续填行也保持格式。纯前端改动，未碰 Edge Function / DB。 | src/routes/gmv-max-create.tsx, src/lib/version.ts | 不需要做任何事，Lovable 同步 main 自动生效。

- ✅ 2026-08-13 [claude] 广告户启用/停用开关 + 国家唯一性收紧为仅在启用广告户间强制；执行授权目标改为「素材列表筛选」与「待授权账户面板开关」AND 生效；执行授权拉取只读 BD 角色；人员表加只读「飞书表格」派生列。**待人工**：跑迁移 `20260813120000_advertiser_countries_active.sql`。`tiktok-connections`、`feishu-read`、`authorize-batch` 三个 Edge Function 已重新部署。 | supabase/migrations/20260813120000_advertiser_countries_active.sql, supabase/functions/{tiktok-connections,feishu-read,authorize-batch}/index.ts, src/lib/store.ts, src/components/settings/{AccountsTable,StaffTable}.tsx, src/routes/index.tsx

- ✅ 2026-08-13 [lovable] 修复 TikTok 授权回调地址随预览域名变化的问题：前端和 `tiktok-oauth-init` 云函数均固定使用已登记的正式回调 `https://ads-auth.lovable.app/oauth/tiktok/callback`，旧前端传入的预览地址也不会被采用。

- ✅ 2026-07-13 [codex] GMV Max 日报移除 VID 查找，仅保留日期/国家聚合；「数据行数」改为「素材数（去重 VID）」。

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
