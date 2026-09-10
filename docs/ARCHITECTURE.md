# 项目架构 — ads-auth (TikTok Feishu Hub)

> 内部工具：从飞书表读素材/人员数据 + TikTok Business API 授权与报表，统一授权、分析、回写飞书表。
> 最后更新：2026-09-09（改架构时请同步本文档）

## 技术栈

- **前端**：TanStack Start（React 19，文件路由）+ shadcn/ui + Tailwind 4 + TanStack Query，由 Lovable 托管部署，运行时为 bun/vite
- **后端**：Supabase Edge Functions（Deno），约 20 个函数
- **数据库**：Supabase Postgres，migrations 在 `supabase/migrations/`
- **鉴权**：自定义口令体系（非 Supabase Auth）——前端 localStorage 存口令，请求带 `x-admin-passcode`/`x-admin-name` 头，Edge Function 用 `_shared/auth.ts` 校验 `app_accounts` 表（sha256），env `ADMIN_PASSCODE` 为 root 兜底；按 tab 分配权限（`src/lib/tabs.ts` 为 tab 注册中心）

## 页面（src/routes/）

| 路由 | 功能 |
| --- | --- |
| `/` index.tsx | 执行授权：拉飞书素材 → 批量授权 TikTok 广告户 → 回写状态 |
| `/material-performance` | 素材成效（GMV Max VID 级数据） |
| `/gmv-max-create` | GMV MAX新建：表单/Excel 批量真实新建 GMV Max 广告组（TikTok 无独立 adgroup 层，等价于建 campaign） |
| `/feishu-data` | 已获取数据查阅（GMV Max 日报等） |
| `/comments` | 评论内容（暂隐藏，API 不支持） |
| `/gmv-attribution` | GMV 归因（管理者视角）：读 Excel 上传按月合并聚合，全量口径（含离职，6 桶口径）；2000 USD 阈值仅展示提示、不自动隐藏，由管理者自行判断是否计入。同事专属查看页留待后续单独加 tab |
| `/gmv-attribution-admin` | GMV 归因·管理视图：月度进度（同上，读 Excel 上传合并聚合 + 唯一 VID 汇总导出）+ Excel 上传归因 + 审查与飞书回写 |
| `/settings` | 账号管理、人员表、数据同步（AccountsManager/StaffTable/DataSyncCard） |
| `/api-test` | API 测试 |
| `/oauth/tiktok/callback` | TikTok OAuth 回调 |
| `/api/public/hooks/gmv-max-cron` | **服务端路由**：pg_cron 调用入口，循环驱动 gmv-max-sync 续跑（apikey=anon key 鉴权，5 分钟硬预算） |
| `/api/public/hooks/attribution-cron` | **服务端路由**：每晚北京 23:30 刷新 GMV 归因结果快照（调 `attribution-upload` 的 `refresh`，默认最近 3 个有批次的月份；apikey 鉴权） |
| `/api/public/hooks/authorize-cron` | **服务端路由**：每日 08:00 自动授权入口，循环 feishu-read → authorize-batch → feishu-writeback，结束发飞书机器人通知（apikey 鉴权，10 分钟硬预算 / 最多 4 轮） |

`routeTree.gen.ts` 自动生成，禁止手改。

## Edge Functions（supabase/functions/）

- **飞书侧**：`feishu-read`（素材表，「建联-姓名」sheet，读 A2:W，P=VID / Q=授权码 / K=SKU / N=登记日期）、`feishu-read-sku` / `feishu-read-editors` / `feishu-read-bd-vids`、`feishu-writeback`（回写授权状态到 V=投放日期 / W=状态）、`staff-sheets`
- **TikTok 侧**：`tiktok-oauth-init` / `tiktok-oauth-exchange` / `tiktok-connection-save` / `tiktok-connections`（token 管理，存 `tiktok_connections`）、`bc-list-advertisers`、`authorize-batch`（核心：素材授权）
- **GMV Max**：`gmv-max-sync`（拉报表写 `gmv_max_vid_daily`，单 token 串行、≤3 QPS、80s 预算、返回 remaining_* 支持续跑）、`gmv-max-raw-export`（只读 CSV：单广告户、最多 31 天、PRODUCT_GMV_MAX 原始返回字段）、`gmv-max-query`、`gmv-max-daily-report`（服务端聚合）、`gmv-max-live-status`（按广告户+Campaign+商品+VID 直接查询 TikTok BC，不读写 GMV 明细表）、`gmv-max-adgroup-create`（写接口：透传 POST `/campaign/gmv_max/create/`，真实新建 GMV Max campaign/广告组，会产生真实花费；不做字段校验，供 API 测试页手填完整 TikTok GmvMaxCreateBody JSON）、`gmv-max-adgroup-batch-create`（写接口：结构化输入 `{rows:[...]}`，`/gmv-max-create` 页面表单与 Excel 批量上传共用；自动按 advertiser_id 从 `advertiser_countries.shop_id`/`tiktok_connections.bc_id` 取 store_id/store_authorized_bc_id，固定 shopping_ads_type=PRODUCT、product_specific_type=CUSTOMIZED_PRODUCTS、optimization_goal=VALUE、deep_bid_type=VO_MIN_ROAS、product_video_specific_type=AUTO_SELECTION，逐行调用，单行失败不影响其余行，返回逐行结果）
- **评论**：`tiktok-comments-sync` / `tiktok-comments-translate`（暂停用）
- **GMV 归因**：`attribution-sync-creators`（读建联表 D用户名/E昵称/N登记日期 + 授权记录归档 + 剪辑表 → `creator_registry`，保护期解析 → `creator_ownership`）、`attribution-run`（月度归因报表，RPC `gmv_attr_monthly_agg` 聚合 + 归因引擎，view=admin/user；代码保留，两个前端页面暂不再读它，见下）、`attribution-upload`（Excel 上传 create/append/finalize/list/get/delete，文件名「站点 MAX yyyymm.xlsx」；`get` 传 `{month,merged:true}` 按月合并全部站点，是当前两个「GMV 归因」页面的实际数据源；`finalize` 会校验汇率覆盖，缺币种直接报错 `missing_currencies` 不写入；另有 `list_exchange_rates`/`save_exchange_rate` 维护 `gmv_exchange_rates`、`export_vid_summary` 按国家×VID×商品ID 聚合导出唯一 VID 汇总、`unmatched_trend` 按国家×达人昵称聚合最近 12 个月 UNMATCHED 桶 GMV、`diagnose` 归因口径自查[逐批次统计商品卡/VID命中/昵称同站点命中/昵称异站点/从未登记 + 站点写法对照 + 结论提示]；**上传与归因已解耦**：finalize 只在数据库里把原始行按 (VID,达人昵称,商品ID,内容类型,币种) 归并成 `ad_upload_agg`，不写任何归因结果，所有报表口径在读取时按当下的飞书登记数据现算）、`attribution-feishu`（write-progress/write-reviews/read-judgments/submit-judgment/sync-targets/sync-handovers/write-ownership/list-reviews，对应飞书主表格内 5 个 sheet：归因进度/归因审查/GMV目标/站点交接/达人归因表；`submit-judgment` 是网页端「归因审查」面板直接判定的入口，立即写 `attribution_review`+昵称类同时写 `creator_alias` MANUAL，并尽力同步回飞书表对应行，飞书失败不影响数据库判定）
- **归因快照（第二层）**：`attribution-upload` 的 `refresh`/`report`/`report_detail`/`runs` 四个 action —— `refresh` 跑一次「全站点全人员」归因并把结果写进 `attribution_runs`+`attribution_run_rows`（cron 带 `x-cron-key` 免口令），`report` 读该月最新 READY 快照供前台秒开，`report_detail` 从快照明细表下钻（不重算），`runs` 列快照历史
- **其他**：`app-accounts`（账号 CRUD）、`data-preview`
- **共享**：`_shared/auth.ts`（口令校验 + service role client）、`_shared/feishu.ts`（tenant token、分页读 sheet、CORS；readRange 支持自定义分块行数，**默认 valueRenderOption=ToString——所有单元格按文本取值**，否则飞书会把 19 位 VID / 商品ID 等纯数字 ID 当 JSON number 返回，超出 JS 2^53 精度被静默改写成末尾补 0 的错值）、`_shared/tiktok.ts`（TikTok GET/POST 限速、超时与退避重试：`ttGet` 只读、`ttPost` 写调用需调用方传 TikTok 要求的幂等 `request_id`）、`_shared/gmv-max-adgroup.ts`（`findConnectionsForAdvertiser`/`createGmvMaxCampaign`/`genRequestId`，`gmv-max-adgroup-create` 与 `gmv-max-adgroup-batch-create` 共用：按广告户找可用授权，逐个 token 重试到某个有 GMV Max 写权限的为止）、`_shared/cells.ts`（cellText/parseDate）、`_shared/attribution.ts`（归因引擎纯函数：瀑布归因/保护期/站点交接分段/VID推断别名/VID>>32 发布时间；昵称类查表统一走 `lookupIdentity`：先「站点+归一化名」精确匹配、落空按全局键兜底）、`_shared/attribution-report.ts`（归因上下文加载 + 汇总 + 月度报表）
- **Cron bypass**：`gmv-max-sync` / `feishu-read` / `authorize-batch` / `feishu-writeback` 均支持 `x-cron-key` header（值=vault secret `gmv_max_cron_secret`，通过 `verify_gmv_cron_key` RPC 校验），用于跳过 admin 口令校验，仅给上述两个 cron 路由使用

## 数据库主要表

`app_accounts`（账号/权限）、`staff_sheets`、`staff_vid_map`、`sku_product_map`、`advertiser_countries`（含 shop_id，即 GMV Max 建单用的 store_id）、`tiktok_connections`（token + bc_id/bc_name，bc_id 即 GMV Max 建单用的 store_authorized_bc_id）、`gmv_max_vid_daily`（明细大表，country×advertiser×campaign×item×day）、`gmv_max_vid_meta`（+posted_at 发布时间）、`gmv_max_sync_state`、`authorize_cron_state`（每日自动授权运行记录）、`tiktok_comments`(+sync_state)

**GMV 归因**：`creator_registry`（达人登记原始行，按 source_sheet 全量重建）、`creator_ownership`（昵称/用户名→BD 保护期解析结果）、`site_handovers`（站点交接，昵称归因按发布时间分段）、`creator_alias`（别名：VID_INFERRED 自动推断 / MANUAL 人工判定，MANUAL 永不被自动覆盖）、`attribution_review`（审查项，review_key 幂等，回写飞书+读回人工判定）、`gmv_targets`（月度目标）、`ad_uploads`+`ad_upload_rows`（Excel 上传批次与原始行；attr_* 四列自 2026-09-10 起废弃不再读写；同 country+month 的 UPLOADING/READY 记录不可重复，重传需 replace_existing 先删旧再插；`ad_upload_rows.upload_id` 是 ON DELETE CASCADE，`delete` action 支持单个 / `upload_ids` 批量 / `all:true` 清空）、`gmv_exchange_rates`（币种→usd_rate，语义=1 美元兑多少本币，折美元=本币/usd_rate；未配置的币种 finalize 时直接拦截，不静默丢弃）、`ad_upload_agg`（**第一层**：按 (upload_id,VID,达人昵称,商品ID,内容类型,币种) 归并的行，归因的唯一输入单位，由 RPC `attribution_build_upload_agg` 在数据库内重建）、`attribution_runs`+`attribution_run_rows`（**第二层**：一次全站点全人员归因的结果快照与明细，带历史；每月保留最近 10 条，RPC `attribution_runs_prune`）；RPC `gmv_attr_monthly_agg`（月度按 vid×账号×内容类型×国家×货币 聚合）、`attribution_unmatched_trend_json`（数据库内汇总指定月份的 UNMATCHED 达人 GMV，并以单个 JSON 结果返回以绕过接口默认 1000 行上限；Edge Function 逐月调用后合并 12 个月，避免单条 SQL 超时）

## 关键数据流

1. **授权流**（手动）：飞书素材表 → `feishu-read` → 前端筛选 → `authorize-batch`（TikTok API）→ `feishu-writeback` 回写状态列
2. **自动授权流**：pg_cron(北京 08:00) → `/api/public/hooks/authorize-cron` → `feishu-read` → `authorize-batch`（最多 4 轮收敛，无授权账号不参与）→ `feishu-writeback` → 飞书自定义机器人（`FEISHU_BOT_WEBHOOK`）富文本通知 → upsert `authorize_cron_state`
3. **报表流**：pg_cron → `/api/public/hooks/gmv-max-cron` → `gmv-max-sync`（循环续跑）→ `gmv_max_vid_daily` → `gmv-max-daily-report` 聚合 → 前端
4. **Token 流**：OAuth 授权 → callback → `tiktok-oauth-exchange` → `tiktok_connections`
5. **归因流**：`attribution-sync-creators`（飞书 3 处登记 → registry + 保护期解析）→ `attribution-run`/`attribution-upload`（归因引擎瀑布：商品卡单列 → VID 强匹配[BD/剪辑] → BD 昵称路径[人工别名>建联归属>VID推断别名]+站点交接按发布时间分段 → 无建联）→ 前端进度板 / `attribution-feishu` 回写飞书（进度快照、审查项、达人归因表）→ 人工在「归因审查」J 列裁决 → read-judgments 读回。发布时间三级来源：上传表内列 > gmv_max_vid_meta.posted_at > VID>>32 时间戳兜底。**当前两个「GMV 归因」前端页面实际只走 Excel 上传这条支路**：`attribution-upload`(finalize) 单文件归因回填 `attr_*` → `get{month,merged:true}` 按月合并全部站点站点重新聚合展示，不重跑引擎；`attribution-run`/`gmv_attr_monthly_agg`（官方 API 数据）链路代码保留，留待后续接回官方数据时再启用。

## 已知约束 / 风险点

- TikTok API：≤3 QPS、429 指数退避；Edge Function 80s 软超时靠 remaining_* 续跑机制兜底
- 飞书 values v2 单响应 ~5000 cells，`readRange` 已做 500 行分块
- `gmv_max_vid_daily` 行数线性增长，性能优化路线见 `.lovable/plan.md`（索引→rollup→分区）
- 删除-重插写入模式：sync 先按 (country, advertiser_id, stat_date) 删旧再 upsert，改动需保持幂等
- 2026-09-10 归因口径：①**上传与归因解耦**——上传只落库+归并，归因结果不再固化，每次出报表按当下 `creator_*` / `site_handovers` 现算；同步达人登记后刷新报表即生效，不需要重传广告表或重跑批次。②**站点写法一律英文简写**（PH / TH / VN / MY / SG / MX-AR / US / JP…），不做任何汉字站点匹配或换算；`create` 拒收含汉字的站点，`attribution-sync-creators` 把汉字站点写法计数返回给前端提示改飞书。③**飞书读取一律 ToString**：纯数字 ID 必须按文本取，见 `_shared/feishu.ts`。
- 2026-09-09 归因口径：①**站点按字母精确匹配，无任何跨站点兜底**——`lookupIdentity` 只查 `identityKey(站点, 归一化名)`。飞书建联表 C 列 / 剪辑表 D 列填的都是站点代码（PH / TH / VN / US / MX-AR），与上传文件名同源。名字对得上但站点对不上的行归 UNMATCHED，由 `attribution-upload` 的 `site_mismatch` action 单独列表（前端 `SiteMismatchTable`，挂在「GMV 归因·管理 → 月度进度」下方）供人工确认，不在归因里静默改判。该 action 用 `creator_ownership` + `creator_alias` 按名字建索引，**只用于诊断、不参与归因**，且读的是已落库的 `attr_bucket`，对历史批次直接生效不用重传。②`KPI_MIN_SITE_USD` 由 2000 改为 **0**（关闭阈值，临时口径），`counted_gmv` = 全部 GMV，前端在阈值 ≤0 时不再显示阈值提示；要恢复把它改回 2000 即可。

- 2026-09-09 Excel 取数口径与诊断：`src/lib/adExcel.ts` 的数字解析由 `parseNumeric` 统一处理（千分位 / 币种符号 / 不换行空格 / 全角数字 / 括号负数），并统计「原文非空但解析不出数字」的金额单元格数——旧实现把这类单元格静默记 0，整列取错时表面看不出异常。`ParsedFile.totals` 新增 `gmvRows`（GMV 非 0 的行数）与 `byCurrency`（按行内「货币」列分组的原币种小计），`ParsedFile.diagnostics` 暴露「缺货币列 / 解析失败单元格 / 未识别表头」，上传页解析后直接告警。**「货币」列已列入 `REQUIRED`，缺失时 `parseAdExcel` 直接 throw 阻断上传**（此前会默认 USD，`findMissingCurrencies` 也不报错，非美元站点 GMV 被当成美元放大几十倍）；列在但单元格为空的行仍按 USD 计并单独告警。业务上目前只应出现 USD / THB（`EXPECTED_CURRENCIES`），迁移 `20260909160000_seed_thb_exchange_rate.sql` 预置 USD=1、THB=32.5。`AttributionReport.non_usd` 每项加 `usd_rate` / `gmv_usd`：`usd_rate=null` 才是「缺汇率未计入」，有值表示已折算计入（旧 UI 一律显示成「未计入」，是误报）。

- 2026-07-11 review implementation: `20260711000000_gmv_attribution_review.sql` adds country-scoped creator identity, configurable USD rates, goal-group fields, and immutable attribution batches/detail snapshots.
