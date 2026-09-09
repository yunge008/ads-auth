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
| GMV 归因进度（按审核计划重构） | ⏸ 已由下方「GMV 归因 V1 落地」接手/取代 2026-09-09 | codex 2026-07-11 → claude 2026-09-09 | docs/GMV_ATTRIBUTION_REVIEW_PLAN.md、supabase/migrations/、supabase/functions/attribution-*、supabase/functions/_shared/{attribution,attribution-report}.ts、src/routes/gmv-attribution*.tsx、src/components/attribution/*、src/lib/{attributionApi,adExcel,tabs}.ts、src/routes/settings.tsx | 该任务近两个月未推进（认领于 2026-07-11），批次固化/定时刷新/原子切换/目标组/2000 美元阈值展示规则等第 7-11 节内容已过时。2026-09-09 claude 按新方案 `GMV_ATTRIBUTION_V1_PLAN.md` 接手同一批文件（范围更小、已落地，见下一行任务），本行仅保留历史记录，不再单独推进；`attribution_batches`/`attribution_batch_details`/`attribution_run_state` 三张表继续保留不接线。 |
| GMV 归因 V1（Excel 上传合并汇总 + 汇率修正 + 唯一VID导出） | ✅ 完成 2026-09-09 | claude 2026-09-09 | supabase/functions/attribution-upload/index.ts、supabase/functions/_shared/attribution-report.ts、src/routes/gmv-attribution*.tsx、src/components/attribution/UploadView.tsx、src/components/settings/ExchangeRateCard.tsx、src/routes/settings.tsx、src/lib/{api,attributionApi}.ts | 见下方「已完成」条目详细说明。**待人工**：重新部署 `attribution-upload` Edge Function。 |
| GMV Max 原始导出 + 多国广告表归因验证 | 🔶 进行中 | codex 2026-07-13 | supabase/functions/gmv-max-raw-export/index.ts、src/routes/api-test.tsx、docs/{ARCHITECTURE,PLAN,WORKLOG}.md、src/components/attribution/UploadView.tsx（仅验证） | 新增独立、只读的 GMV Max CSV 导出 Function，按广告户与日期范围拉取；不改变 gmv-max-sync。优先验证同月多国家多 Excel 上传、归因及合并展示。 |
| 前端显示「上次自动刷新时间」 | ⬜ | — | src/routes/feishu-data.tsx | 读 gmv_max_sync_state（cron_yesterday / cron_today） |
| GMV Max 广告组新建 API | ✅ 完成（已部署 2026-08-19 lovable） | claude 2026-08-19 | supabase/functions/gmv-max-adgroup-create/index.ts、supabase/functions/_shared/tiktok.ts、src/routes/api-test.tsx | TikTok GMV Max 无独立 campaign/adgroup/ad 三层，新建广告组即调用 `/campaign/gmv_max/create/`（含预算/商品/出价，等价于把广告组打包进 campaign）。新函数只做鉴权+按 advertiser_id 查 token+透传 POST，不校验/拼装业务字段，需在 API 测试页命令框手填完整 TikTok GmvMaxCreateBody JSON（含 request_id 保证幂等）。真实写调用，会产生真实花费，测试前确认参数。新增 `_shared/tiktok.ts` 的 `ttPost`（同 `ttGet` 限速/退避）。 |
| GMV MAX新建页面（表单+Excel批量） | ✅ 完成（已部署 2026-08-25 lovable） | claude 2026-08-25 | src/routes/gmv-max-create.tsx、src/lib/tabs.ts、supabase/functions/gmv-max-adgroup-batch-create/index.ts、supabase/functions/_shared/gmv-max-adgroup.ts、supabase/functions/gmv-max-adgroup-create/index.ts（重构复用共享逻辑）、supabase/functions/{tiktok-oauth-exchange,tiktok-connection-save,tiktok-connections}/index.ts、src/routes/oauth.tiktok.callback.tsx、src/lib/store.ts、src/components/settings/AccountsTable.tsx、supabase/migrations/20260825120000_tiktok_connections_bc_name.sql | 新 tab「GMV MAX新建」（放在素材成效下、GMV归因上）。页面：①单个新建表单——广告户下拉（自动读 store_id/BC ID，缺失会提示去设置页补）、广告组名称、商品ID多行文本框、ROI、预算、开始/结束时间（datetime-local，默认马上开始/不设结束）；②Excel 批量新建——同一套字段的表格上传（含"下载模板"按钮），前端用 xlsx 解析、校验后调同一个批量接口。新 Edge Function `gmv-max-adgroup-batch-create` 接受结构化 `{rows:[...]}`，自动从 `advertiser_countries.shop_id`/`tiktok_connections.bc_id` 取 store_id/store_authorized_bc_id，固定其余字段（PRODUCT/CUSTOMIZED_PRODUCTS/VALUE/VO_MIN_ROAS/AUTO_SELECTION），逐行创建、单行失败不影响其余行。抽出 `_shared/gmv-max-adgroup.ts`（`findConnectionsForAdvertiser`/`createGmvMaxCampaign`/`genRequestId`）给这个新函数和原 `gmv-max-adgroup-create` 共用。顺带在设置页「TikTok 授权连接」表加 BC 名称/BC ID 两列（`tiktok_connections` 新增 `bc_name` 列，`tiktok-oauth-exchange` 授权时顺带查 `/bc/get/` 拿名称）。① 迁移、② 五个 Edge Function 部署已于 2026-08-25 由 lovable 完成。**待人工**：③ 有权限的账号需要在账号管理里给自己加 `gmv-max-create` tab 权限才能看到新 tab（管理员账号不受限）④ 真实写调用，首次用小额预算/短时间验证后再放量。 |
| 发样及素材统计 tab | ✅ 完成（**已重新部署 connection-stats-query 2026-09-09**；权限待人工授权） | claude 2026-09-09 | supabase/migrations/20260826130000_connection_material_registry.sql, supabase/functions/{gmv-max-identity-get,feishu-read-connection-stats,connection-stats-query}/index.ts, src/routes/connection-stats.tsx, src/components/AppShell.tsx, src/lib/tabs.ts, src/components/settings/DataSyncCard.tsx, src/lib/version.ts | 新 tab「发样及素材统计」（放在素材成效上方），只读展示，不回写飞书。数据源：5 张 BD「建联-xxx」表（A2:Q）+ 剪辑登记表 2 个 sheet（B2:G），经 `feishu-read-connection-stats` 同步进新缓存表 `connection_material_registry`（按 source_sheet 先删后插），`connection-stats-query` 做聚合返回给页面。口径：发样记录=(达人,国家,SKU)三元组去重；BD 回收有效日期=N列视频登记日期（非O列发布日期）；剪辑回收有效日期=C列日期(发布日期)；只看 VID 格式不校验授权码；国家占比/粉丝分层两个饼图只统计 BD；粉丝分层按各达人自己所在国家门槛定档后跨国家合并；BD 日均回收/剪辑日均产出都按等效工作日（一~五各1天、周六0.5天、周日0天）折算；country 字段同步时统一转大写；`connection-stats-query` 加 `include_meta` 避免全表扫下拉项；回收明细分组维度为 `group_country`/`group_sku` 两个独立布尔。**2026-09-08 修复 SKU 搜索**：之前的匹配函数要求「查询串本身是纯数字」，输入 AR333 这种带字母前缀完全不命中；改成按 token 分类——含数字的 token（"333"/"AR333"，忽略字母）按数字整段精确匹配（命中 333-A/AR333，不命中 3331/AR3331），纯字母 token（"B"/"K"）按大小写不敏感子串匹配整个 sku；前端多 token 分隔符加「&」（如 333&B = 333 数字整段 OR 含 B），输入框右侧加提示「用&可合并搜索，如 333&B」。**进展（2026-09-05 lovable 核查）**：①迁移已执行（36678 行）②函数已重新部署 ③country 已全部大写（0 行异常），无需再手动同步。**2026-09-09 [claude] 每日发样/回收图表加剪辑素材**：标题「发样数量 / 回收素材数量（BD）」去掉「（BD）」；`connection-stats-query` 的 `daily_series` 每项新增 `editor_recover`（剪辑当日回收计数，口径同已有的剪辑回收：vid 去重、有效日期=post_date）；前端第二根柱子改为 BD素材（蓝，底）+ 剪辑素材（红，堆叠在上）；发样/BD素材/剪辑素材三个图例改成可点击开关，各自独立控制对应柱子是否显示，Y 轴按当前勾选的数据重新缩放；回收率折线本质是 BD 口径（recover/sample），当发样和 BD素材两个开关都关闭时（含只剩剪辑素材一项）自动隐藏折线和右侧百分比轴。**待人工**：管理员在账号管理里给需要的账号加 `connection-stats` 权限。 |

## 进行中文件锁（防交叉修改）

（当前无进行中锁；2026-09-09 claude 完成 GMV 归因 V1 后解除上条 codex 2026-07-11 的锁，该任务已标记 ⏸ 取代，详见任务板。）

## 已完成

- ✅ 2026-09-09 [claude] **GMV 归因 V1 落地**（按 `GMV_ATTRIBUTION_V1_PLAN.md`）：①「GMV 归因」与「GMV 归因·管理」的「月度进度」都从读官方 API 链路（`attribution-run`/`gmv_attr_monthly_agg`/`gmv_max_vid_daily`，代码保留不删）切换为读 Excel 上传按月合并聚合（`attribution-upload` 的 `get action + merged:true`）；两页均为管理者视角展示全量口径（含离职、6 桶明细），2000 美元 KPI 阈值仅作展示提示不自动隐藏——按项目负责人确认，同事专属查看页留待后续单独加 tab，本次不做该权限/过滤分离。②修复同站点同月重复上传导致月度汇总翻倍：`attribution-upload` 的 `create` action 增加 `(country,month)` 状态为 UPLOADING/READY 的重复检测，默认报错（`payload.duplicate`），`replace_existing=true` 先删旧记录（级联删其行）再插入；`UploadView.tsx` 捕获后弹窗确认自动重试。③汇率：修正 `aggregateResults` 换算公式为「本币金额 / usd_rate」（`usd_rate` 语义统一为「1 美元 = 多少本币」，如 THB 填 33；此前是乘不是除，且历史未有非 USD 汇率数据，无存量脏数据需要迁移）；`finalize` 时新增 `findMissingCurrencies` 校验，缺币种直接报错（`payload.missing_currencies`）且不写 `attr_*`/不置 READY；`UploadView.tsx` 捕获后弹出输入框逐个补录（1 美元=多少本币）自动重试；设置页新增「GMV 归因汇率」tab（`ExchangeRateCard.tsx`，仅管理员可见）维护 `gmv_exchange_rates`。④新增唯一 VID 汇总导出：`attribution-upload` 新增 `export_vid_summary` action，按 (国家,VID,商品ID) 重新分组聚合（GMV/消耗折美元求和，ROI/CTR/CVR 聚合后重算，分母 0 留空；达人昵称取组内出现最多的），PID→SKU 复用 `gmv-max-query` 的 skuByPid 取首条模式；前端在「月度进度」toolbar 新增「导出唯一VID汇总」按钮，用现有 `xlsx` 库本地生成 14 列文件（未走服务端生成二进制，实现更简单、复用现有前端 xlsx 落地方式）。⑤`src/lib/api.ts` 的 `invokeFn` 增加把服务端返回的完整错误 JSON 挂到 `Error.payload`，供以上两处结构化错误（duplicate/missing_currencies）前端读取。**协作说明**：本任务涉及文件与 codex 认领的「GMV 归因进度（按审核计划重构）」（2026-07-11起，近两个月未推进）完全重叠，按项目负责人确认直接接手执行并已在任务板标注取代关系。**待人工**：重新部署 `attribution-upload` Edge Function（唯一改动的函数，未新建/未改其它函数，无需跑迁移）。 | supabase/functions/attribution-upload/index.ts、supabase/functions/_shared/attribution-report.ts、src/routes/{gmv-attribution,gmv-attribution-admin}.tsx、src/components/attribution/UploadView.tsx、src/components/settings/ExchangeRateCard.tsx、src/routes/settings.tsx、src/lib/{api,attributionApi,version}.ts

- ✅ 2026-08-26 [claude] 新增只读诊断 Edge Function `gmv-max-identity-get`：透传 TikTok `GET /gmv_max/identity/get/`，用于在 API测试页验证「授权所有账号（BC 已授权 TikTok 账号）」能否被查到，为「GMV Max 建单缺 identity_list」修复计划（见本文件下方任务）做前期验证，本身只读不建单不改动任何数据。已于 2026-08-27 由 lovable 重新部署。 | supabase/functions/gmv-max-identity-get/index.ts, src/lib/version.ts | 部署后在「API测试」页「通用查询指令」框粘贴：`gmv-max-identity-get {"advertiser_id":"你的广告户ID"}` 执行测试，store_id 会自动从 advertiser_countries.shop_id 取，不用手填。

- ✅ 2026-08-26 [claude] GMV MAX新建页面底部加两个 TikTok 官方 API 文档链接（新标签页打开）：「GMV MAX创建API」→ https://business-api.tiktok.com/portal/docs/create-product-gmv-max-campaigns/v1.3 ，「GMV MAX修改API」→ https://business-api.tiktok.com/portal/docs/update-a-gmv-max-campaign/v1.3 。纯前端文案改动。 | src/routes/gmv-max-create.tsx, src/lib/version.ts | 不需要做任何事，Lovable 同步 main 自动生效。

- ✅ 2026-08-26 [claude] GMV MAX新建页面 · 恢复上下排版：「单个新建」/「Excel 批量新建」两张卡片改回上下堆叠（撤销上一次的左右并排 grid）；「单个新建」内部改为第一行 6 项并排（广告户/广告组名称/ROI/预算/开始时间/结束时间，`grid-cols-2 sm:grid-cols-3 lg:grid-cols-6`），第二行商品ID多行文本框独占整行（`rows={2}` 默认两行高、`w-full`）。仅布局调整，未改校验/提交逻辑。 | src/routes/gmv-max-create.tsx, src/lib/version.ts | 不需要做任何事，Lovable 同步 main 自动生效。

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
