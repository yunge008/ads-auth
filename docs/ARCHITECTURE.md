# 项目架构 — ads-auth (TikTok Feishu Hub)

> 内部工具：从飞书表读素材/人员数据 + TikTok Business API 授权与报表，统一授权、分析、回写飞书表。
> 最后更新：2026-07-05（改架构时请同步本文档）

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
| `/feishu-data` | 已获取数据查阅（GMV Max 日报等） |
| `/comments` | 评论内容（暂隐藏，API 不支持） |
| `/settings` | 账号管理、人员表、数据同步（AccountsManager/StaffTable/DataSyncCard） |
| `/api-test` | API 测试 |
| `/oauth/tiktok/callback` | TikTok OAuth 回调 |
| `/api/public/hooks/gmv-max-cron` | **服务端路由**：pg_cron 调用入口，循环驱动 gmv-max-sync 续跑（apikey=anon key 鉴权，5 分钟硬预算） |
| `/api/public/hooks/authorize-cron` | **服务端路由**：每日 08:00 自动授权入口，循环 feishu-read → authorize-batch → feishu-writeback，结束发飞书机器人通知（apikey 鉴权，10 分钟硬预算 / 最多 4 轮） |

`routeTree.gen.ts` 自动生成，禁止手改。

## Edge Functions（supabase/functions/）

- **飞书侧**：`feishu-read`（素材表，「建联-姓名」sheet，读 A2:W，P=VID / Q=授权码 / K=SKU / N=登记日期）、`feishu-read-sku` / `feishu-read-editors` / `feishu-read-bd-vids`、`feishu-writeback`（回写授权状态到 V=投放日期 / W=状态）、`staff-sheets`
- **TikTok 侧**：`tiktok-oauth-init` / `tiktok-oauth-exchange` / `tiktok-connection-save` / `tiktok-connections`（token 管理，存 `tiktok_connections`）、`bc-list-advertisers`、`authorize-batch`（核心：素材授权）
- **GMV Max**：`gmv-max-sync`（拉报表写 `gmv_max_vid_daily`，单 token 串行、≤3 QPS、80s 预算、返回 remaining_* 支持续跑）、`gmv-max-query`、`gmv-max-daily-report`（服务端聚合）、`gmv-max-live-status`（按广告户+Campaign+商品+VID 直接查询 TikTok BC，不读写 GMV 明细表）
- **评论**：`tiktok-comments-sync` / `tiktok-comments-translate`（暂停用）
- **其他**：`app-accounts`（账号 CRUD）、`data-preview`
- **共享**：`_shared/auth.ts`（口令校验 + service role client）、`_shared/feishu.ts`（tenant token、分页读 sheet、CORS）、`_shared/tiktok.ts`（TikTok GET 限速、超时与退避重试）
- **Cron bypass**：`gmv-max-sync` / `feishu-read` / `authorize-batch` / `feishu-writeback` 均支持 `x-cron-key` header（值=vault secret `gmv_max_cron_secret`，通过 `verify_gmv_cron_key` RPC 校验），用于跳过 admin 口令校验，仅给上述两个 cron 路由使用

## 数据库主要表

`app_accounts`（账号/权限）、`staff_sheets`、`staff_vid_map`、`sku_product_map`、`advertiser_countries`、`tiktok_connections`（token）、`gmv_max_vid_daily`（明细大表，country×advertiser×campaign×item×day）、`gmv_max_vid_meta`、`gmv_max_sync_state`、`authorize_cron_state`（每日自动授权运行记录）、`tiktok_comments`(+sync_state)

## 关键数据流

1. **授权流**（手动）：飞书素材表 → `feishu-read` → 前端筛选 → `authorize-batch`（TikTok API）→ `feishu-writeback` 回写状态列
2. **自动授权流**：pg_cron(北京 08:00) → `/api/public/hooks/authorize-cron` → `feishu-read` → `authorize-batch`（最多 4 轮收敛，无授权账号不参与）→ `feishu-writeback` → 飞书自定义机器人（`FEISHU_BOT_WEBHOOK`）富文本通知 → upsert `authorize_cron_state`
3. **报表流**：pg_cron → `/api/public/hooks/gmv-max-cron` → `gmv-max-sync`（循环续跑）→ `gmv_max_vid_daily` → `gmv-max-daily-report` 聚合 → 前端
4. **Token 流**：OAuth 授权 → callback → `tiktok-oauth-exchange` → `tiktok_connections`

## 已知约束 / 风险点

- TikTok API：≤3 QPS、429 指数退避；Edge Function 80s 软超时靠 remaining_* 续跑机制兜底
- 飞书 values v2 单响应 ~5000 cells，`readRange` 已做 500 行分块
- `gmv_max_vid_daily` 行数线性增长，性能优化路线见 `.lovable/plan.md`（索引→rollup→分区）
- 删除-重插写入模式：sync 先按 (country, advertiser_id, stat_date) 删旧再 upsert，改动需保持幂等
