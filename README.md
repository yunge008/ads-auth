# TikTok Feishu Hub

内部运营工具，打通**飞书表格**与 **TikTok Business API**，实现素材广告授权自动化 + GMV Max 报表自动拉取。

---

## 业务背景

运营人员在飞书各自的 sheet 中填写待授权素材（达人视频 VID + 平台授权码 + 国家），工具负责：

1. 从飞书批量拉取素材
2. 匹配对应国家的 TikTok 广告户
3. 调用 TikTok API 完成授权
4. 将结果（已授权 / 代码过期 / 代码有误等）回写飞书

同时每天自动拉取 GMV Max 广告报表（VID 级），供团队在前端查询分析。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | TanStack Start (React 19, 文件路由) + shadcn/ui + Tailwind 4 + TanStack Query |
| 后端 | Supabase Edge Functions (Deno，约 20 个函数) |
| 数据库 | Supabase Postgres + pg_cron |
| 部署 | Lovable 托管（bun/vite），前后端双向同步 `main` 分支 |
| 鉴权 | 自定义口令体系（非 Supabase Auth），按 tab 分配权限 |

---

## 待办总览

按功能线整理的现状 / 待办 / 注意事项：**[docs/ROADMAP.md](docs/ROADMAP.md)**（负责人看这一份即可；任务认领在 `docs/PLAN.md`，完工日志在 `docs/WORKLOG.md`）。

| 功能线 | 一句话现状 |
|---|---|
| 素材授权 | 手动 + 每日 08:00 自动授权在用 |
| GMV Max 取数 | ⚠️ 每日同步 2026-10-12 起暂停，待定取数方案 |
| GMV Max 建组 / 迁移 | 批量 / 单条 / 账户复制在用，走免费服务端路由 |
| GMV 归因 | 每晚快照在用；V3 引擎切换阶段 3 ②–⑨ 待做 |
| 达人建联 | P0 实测通过，仅「申样审核建议」上线；定向计划 / 批样 / 插件 / 多账户待开发 |
| 店铺运营 | 数据导出、SEA 库存、上架工具链部分上线 |

---

## 页面（左侧导航分组）

| 分组 | 页面 | 路由 |
|---|---|---|
| 素材授权 | 执行授权 / 发样及素材统计 / 素材成效 | `/` `/connection-stats` `/material-performance` |
| GMV Max | 新建广告组 / 数据查阅 | `/gmv-max-create` `/feishu-data` |
| GMV 归因 | 归因结果 / 归因管理 | `/gmv-attribution` `/gmv-attribution-admin` |
| 达人建联 | 达人建联 | `/outreach` |
| 店铺 | 数据导出 / SEA 库存 | `/tts-export` `/sea-inventory` |
| 置底 | 设置 / API 测试 | `/settings` `/api-test` |

分组在 `src/lib/tabs.ts` 的 `group` 字段配置；权限仍按单个页面 key 分配。

---

## 核心数据流

### 1. 手动授权流

```
飞书素材表
  └─ feishu-read（拉取启用人员的所有 sheet，过滤未授权）
       └─ 前端筛选 + 展示
            └─ authorize-batch（按广告户并发，≤8，同户串行，≤3 QPS，429 指数退避）
                 └─ feishu-writeback（回写状态列 + 授权记录 sheet）
```

素材状态枚举：`待授权` / `授权中` / `已授权` / `代码过期` / `代码删除` / `代码有误` / `代码涉及多素材` / `视频不可见` / `API错误` / `无授权账号`

### 2. 自动授权流（每日定时）

```
pg_cron（北京 08:00 = UTC 00:00）
  └─ POST /api/public/hooks/authorize-cron
       ├─ feishu-read（拉全部待授权素材）
       ├─ authorize-batch（最多 4 轮收敛，10 分钟硬预算）
       ├─ feishu-writeback（回写结果）
       └─ 飞书自定义机器人通知（FEISHU_BOT_WEBHOOK）
            └─ upsert authorize_cron_state（记录每次运行结果）
```

通知内容示例：`✅ 成功 12 条 ｜ ❌ 失败 2 条 ｜ ⚠️ 无授权账号 1 条`

### 2.5 飞书基础数据自动同步（每晚）

```
pg_cron（北京 23:00 = UTC 15:00）
  └─ POST /api/public/hooks/feishu-sync-cron
       ├─ feishu-read-connection-stats（发样及素材统计）
       ├─ attribution-sync-creators（达人登记：建联 + 归档 + 剪辑）
       ├─ attribution-feishu / sync-targets（GMV 目标）
       └─ attribution-feishu / sync-handovers（站点交接）
            ├─ upsert gmv_max_sync_state('feishu_nightly_sync')
            └─ 有失败时发飞书机器人通知（FEISHU_BOT_WEBHOOK）
```

排在归因快照（北京 23:30 的 `attribution-cron`）之前半小时：快照按「当下的登记数据」现算，先同步完当晚快照才用得上当天的新数据。四步串行、互不影响，单步 4 分钟超时。

### 3. GMV Max 报表流

```
pg_cron（北京 03:00 拉昨日全量；每小时拉今日增量）
  └─ GET /api/public/hooks/gmv-max-cron
       └─ gmv-max-sync（单 token 串行，≤3 QPS，80s 软超时 + remaining_* 续跑）
            └─ gmv_max_vid_daily（写入/更新，country×advertiser×campaign×item×day）
                 └─ gmv-max-daily-report（服务端聚合）→ 前端展示
```

### 4. Token 管理流

```
TikTok OAuth 授权
  └─ tiktok-oauth-init → 跳转 TikTok 授权页
       └─ /oauth/tiktok/callback → tiktok-oauth-exchange
            └─ tiktok-connections（存储 access_token + advertiser_ids）
```

---

## 数据库主要表

| 表 | 说明 |
|---|---|
| `app_accounts` | 系统账号与权限（自定义口令） |
| `staff_sheets` | 人员与飞书 sheet 映射 |
| `tiktok_connections` | TikTok OAuth token，一对多 advertiser_ids |
| `advertiser_countries` | 广告户与国家映射 |
| `gmv_max_vid_daily` | GMV Max 明细大表（含 4 条性能索引） |
| `gmv_max_sync_state` | 报表同步状态（续跑游标） |
| `authorize_cron_state` | 自动授权每日运行记录 |
| `staff_vid_map` | 人员与 VID 对应关系 |
| `sku_product_map` | SKU / 产品映射 |

---

## Edge Functions

| 分类 | 函数 |
|---|---|
| 飞书 | `feishu-read` / `feishu-read-sku` / `feishu-read-editors` / `feishu-read-bd-vids` / `feishu-writeback` / `staff-sheets` |
| TikTok 授权 | `tiktok-oauth-init` / `tiktok-oauth-exchange` / `tiktok-connection-save` / `tiktok-connections` / `bc-list-advertisers` / `authorize-batch` |
| GMV Max | `gmv-max-sync` / `gmv-max-query` / `gmv-max-daily-report` |
| 其他 | `app-accounts` / `data-preview` |
| 共享 | `_shared/auth.ts`（口令校验 + service role client）/ `_shared/feishu.ts`（tenant token / 分页读 sheet / CORS） |

所有被 cron 调用的函数（`feishu-read` / `authorize-batch` / `feishu-writeback` / `gmv-max-sync`）支持 `x-cron-key` header，通过 `verify_gmv_cron_key` RPC 校验 vault secret 以绕过 admin 口令。

---

## 已知约束

- TikTok API 限速 ≤3 QPS，429 时指数退避（最多 4 次重试）
- Edge Function 软超时 80s，GMV Max 通过 `remaining_*` 字段实现跨请求续跑
- 飞书 values v2 单响应约 5000 cells，`readRange` 已做 500 行分块
- `gmv_max_vid_daily` 行数线性增长，性能优化路线：索引（已落库）→ rollup 表 → 按月分区
- DB 改动只走 `supabase/migrations/` 新文件，不改历史 migration

---

## 环境变量 / Secrets

| 变量 | 用途 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭证 |
| `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` | TikTok Business 应用凭证 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase 连接 |
| `ADMIN_PASSCODE` | root 管理员口令兜底 |
| `FEISHU_BOT_WEBHOOK` | 飞书自定义机器人 webhook，用于自动授权结果通知 |
| vault: `gmv_max_cron_secret` | cron 调用 Edge Function 的旁路密钥 |

---

## 本地开发

```bash
# 安装依赖
bun install

# 启动开发服务器
bun dev

# 部署 Edge Functions
supabase functions deploy <function-name>
```

> 开工前先 `git pull`，完工后 commit + push。协作规则详见 `AGENTS.md`，任务板见 `docs/PLAN.md`。

---

## 多工具协作

本项目由 **Lovable**（主力开发）+ **Claude / Codex**（辅助）+ **人类**（决策）协同维护。

- `AGENTS.md` — 协作规则
- `docs/ARCHITECTURE.md` — 架构详情
- `docs/PLAN.md` — 当前任务板
- `docs/WORKLOG.md` — 完工日志（只追加）
