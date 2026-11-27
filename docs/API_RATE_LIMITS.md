# 外部 API 限速登记与核对

> 用途：把全项目对 TikTok Shop API、TikTok Business（BC/Ads）API 等外部接口的调用需求放在一处，**每次新增/修改调用、或新增定时任务时核对**，防止超速导致部分功能静默缺数据。
> 核对脚本：`bash tools/check-api-limits.sh`。代码里出现、本文「登记表」没有的接口路径会被列出并返回非 0；把新路径补进对应表格（含频率、峰值估算）后再提交。
> 标记：✅ 已核验 ｜ ⚠️ 未核验/估算 ｜ 🔴 已知超速风险

最后更新：2026-11-27（1127.347）

---

## 1. 官方限额

### 1.1 TikTok Shop Open API（Partner Center「Rate limits」文档，✅ 2026-11-27 全文读过）

- **按 App × Shop 动态限额**，平台按负载调整，不公布固定值；不同接口、不同操作类型单独计数。
- 文档给的参考量级：重写入 / Analytics 类 **0.2–1 次/秒**；普通写 1–3；普通读/同步 3–10；轻量读/批量 5–20。批量接口一次调用只算 1 次。
- 被限流信号：HTTP **429** 或业务码 **36009002**；应读 `Retry-After`，指数退避加抖动（文档示例：基数 1s、上限 60s、最多 5 次）。503 是服务端问题，不是限流。
- 店铺停用：401 + 36009043 / 36009044（不是限流，重试无用）。沙箱 1000 次/小时（36009037）。

### 1.2 TikTok Business API（⚠️ 官方页面是 JS 渲染，未能直接读到，以下为检索结果）

- **按开发者应用 × 接口计数**（所有广告户、所有授权连接共用同一个桶）；限额有 QPS / QPM / QPD 三档。
- 默认 Basic 等级：一般接口 10 QPS / 600 QPM；**`/gmv_max/report/get/`：8 QPS / 240 QPM**。
- **超出 QPM 后要等 5 分钟才恢复**（期间全部报 40100「Too many requests」）。
- 等级可在应用的 Authorization 页逐级申请提升。
- 来源：[Rate limits Overview](https://business-api.tiktok.com/portal/docs/rate-limits/v1.3)、[Run a GMV Max Campaign report](https://business-api.tiktok.com/portal/docs/run-a-gmv-max-campaign-report/v1.3)、[bruin ingestion-index](https://github.com/bruin-data/ingestion-index/blob/main/results/tiktok_ads.md)。🙋 负责人可在 TikTok for Business 开发者后台 → 应用 → Rate limit 截图确认本应用实际等级，确认后把 ⚠️ 改 ✅。

---

## 2. 现有客户端的限速/重试实现

| 客户端 | 位置 | 间隔 | 限流判定 | 退避 | 读 Retry-After |
|---|---|---|---|---|---|
| `ttGet` / `ttPost`（BC） | `supabase/functions/_shared/tiktok.ts`（Node 路由也引用） | 成功后等 150ms；**无跨请求/跨进程全局限速** | 40100、50002、消息含 Too many requests / frequent | 3s·2ⁿ，共 5 次（总等约 45s） | 否 |
| `authOne`（BC 素材授权） | `authorize-batch/index.ts` | 无；8 个广告户并发 | 消息含 too many requests / rate limit、429 | 1s·2ⁿ+抖动，共 5 次 | 否 |
| `ttsCall`（Shop） | `supabase/functions/_shared/tts.ts` | 同一 isolate 内 ≥350ms（≈2.8 QPS） | 429、36009002；5xx 也重试 | min(8s, 1s·2ⁿ)+0–400ms，共 5 次 | 否 |
| `ttsGet`（Shop，Node） | `src/lib/creator-orders.server.ts` | **无间隔** | 429、36009002；5xx、网络错也重试 | 1/2/4s，共 4 次 | 否 |

**结论**：BC 的 240 QPM 罚等 5 分钟，现有退避最多等约 45 秒 → 一旦触发，本轮剩余请求全部失败。是否「静默」取决于调用方怎么记错（见 §4）。

---

## 3. 登记表（脚本读取第一列反引号里的路径；新路径必须登记）

### 3.1 TikTok Business（BC）——全部共用一个应用桶

| 路径 | 调用方 | 触发 | 每次调用量（估） | 峰值 |
|---|---|---|---|---|
| `/gmv_max/report/get/` | 达人出单 `creator-orders`（同步） | pg_cron `creator-orders-step` 每 5 分钟，每次 ≤25s；页面「立即刷新」 | 29 户×3 天=87 单元/小时；每单元 1+⌈活动数/50⌉+⌈SPU/20⌉ 次，大户切半重试 | 串行，单进程实测约 1–3 次/秒 → **≤约 180 QPM** ⚠️ |
| `/gmv_max/report/get/` | 素材成效 / 对账 `gmv-max-material` | 手动 | 每户×每天数次～数十次 | 串行 ≤约 180 QPM ⚠️ |
| `/gmv_max/report/get/` | 建组页近 N 天消耗 `gmv-max-write`、`gmv-max-live-status`、`gmv-max-raw-export`（经 `_shared/gmv-max-report.ts`）、`gmv-max-sync`（已暂停） | 手动 | 每次几～几十次 | 串行 |
| `/gmv_max/campaign/get/` | 同上各处 + 达人出单 | 同上 | 每户每天 1～数页 | 低 |
| `/gmv_max/video/get/` | `gmv-max-material` | 手动 | 少量 | 低 |
| `/gmv_max/store/list/` | `gmv-max-write`、`gmv-max-campaign-info` | 手动 | 1 | 低 |
| `/gmv_max/identity/get/` | `gmv-max-write`、`gmv-max-identity-get` | 手动 | 1/户 | 低 |
| `/gmv_max/exclusive_authorization/create/` | `gmv-max-write`（按钮已下线） | — | 0 | — |
| `/campaign/gmv_max/create/` | `gmv-max-write`、`_shared/gmv-max-adgroup.ts` | 建组手动 | Excel 一批 = 行数 | 串行 |
| `/campaign/gmv_max/info/` | `gmv-max-write`、`gmv-max-campaign-info` | 建组手动 | 每组 1～2 | 串行 |
| `/campaign/gmv_max/update/` | `gmv-max-write` | 建组手动 | 每组 1～若干（BUSY 退避 5/10/20s） | 串行 |
| `/store/product/get/` | `gmv-max-write`（商品预检） | 建组手动 | 每店数页 | 低 |
| `/identity/get/` | `gmv-max-write` | 手动 | 1/户 | 低 |
| `/bc/get/` | `gmv-max-write`、`tiktok-oauth-exchange` | 授权回调 | 1 | 低 |
| `/oauth2/access_token/` | `tiktok-oauth-exchange` | 授权回调 | 1 | 低 |
| `/advertiser/info/` | `balance-alert`、`bc-list-advertisers`、`gmv-max-sync` | 每日 10:00 + 设置页打开 | 每 100 户 1 次 | 低 |
| `/advertiser/balance/get/` | `balance-alert` | 每日 10:00 | 每户/每 BC 1 次 | 低 |
| `/report/integrated/get/` | `balance-alert` | 每日 10:00 | 每户 1 次 | 低 |
| `/tt_video/authorize/` | `authorize-batch` | 每日 19:00 自动 + 首页手动 | 每条素材 1 次 | 🔴 首页 3 路×每路 8 户并发 = 最多 24 并发，可能超 10 QPS（失败会显示在结果行，不静默） |
| `/adgroup/get/` | `tiktok-comments-sync` | 手动（评论内容 tab 已隐藏） | 少量 | 低 |
| `/comment/list/` | `tiktok-comments-sync` | 同上 | 少量 | 低 |

### 3.2 TikTok Shop——按 App × Shop 计数（各店独立）

| 路径 | 调用方 | 触发 | 每次调用量（估） | 峰值（单店） |
|---|---|---|---|---|
| `/analytics/202509/shop_products/{x}/performance` | 评论查看 `reviews` | 每晚北京 00:35/01:35/02:35 + 手动「同步」 | 每商品 1 次（+180 天回补分段）；✅ 2026-11-27 实测 PH 734 次、TH 635 次无报错 | ≈2.8 次/秒（高于 Analytics 参考 0.2–1）⚠️ 目前未触发限流 |
| `/analytics/202605/shop_products/performance` | `reviews` | 同上 | 每店数页 | 低 |
| `/analytics/202605/shop_videos/performance` | 达人出单补名、`gmv-max-material` | 每 5 分钟（仅缺名时） | 每站点 ≤5 页 | **无间隔**，单店 ≤约 1–2 次/秒 ⚠️ |
| `/analytics/202609/shop_videos/batch_performance` | 达人出单补名、`gmv-max-material` | 同上 | 每 100 个 VID 1 次 | 同上 ⚠️ |
| `/analytics/202409/shop_videos/performance` | `gmv-max-material` | 手动 | 少量 | 低 |
| `/analytics/202509/shop_videos/{x}/performance` | `gmv-max-material` | 手动 | 每 VID 1 次 | 2.8/s 上限（ttsCall 不适用，Node 版） |
| `/order/202309/orders/search` | `tts-export`（每日入库）、`sea-inventory`、`tts-p0-probe` | `tts-daily-sync` 每小时第 17 分（PH、TH，≤8 分钟）；SEA 库存每日 2 次 | 每页 100 单 | ≈2.8/s |
| `/order/202309/orders` | `tts-export` | 同上 | 每 50 单 1 次 | ≈2.8/s |
| `/finance/202309/statements` | `tts-export` | 同上 | 每店每天数页 | ≈2.8/s |
| `/finance/202501/statements/{x}/statement_transactions` | `tts-export`、`tts-p0-probe` | 同上 | 每结算单数页 | ≈2.8/s |
| `/return_refund/202602/returns/search` | `tts-export` | 同上 | 每店数页 | ≈2.8/s |
| `/affiliate_seller/202410/orders/search` | `tts-export`、`tts-p0-probe` | 手动导出 | 每页 | ≈2.8/s |
| `/affiliate_seller/202508/sample_applications/search` | `tts-export`、`tts-p0-probe` | 手动 | 每页 | 低 |
| `/affiliate_seller/202608/marketplace_creators/{x}` | `tts-export` | 手动 | 每达人 1 次 | ≈2.8/s |
| `/promotion/202309/activities/{x}` | `tts-export` | 手动 | 每活动 1 次 | 低 |
| `/product/202502/products/search` | `tts-export`、`reviews`、`sea-inventory`、`tts-listing` | 手动/定时 | 每页 | ≈2.8/s |
| `/product/202309/products/{x}` | `tts-export`、`reviews`、`tts-listing` | 手动/定时（reviews 补名称） | 每商品 1 次 | ≈2.8/s |
| `/product/202309/inventory/search` | `sea-inventory` | SEA 库存每日 2 次 | 每批 | 低 |
| `/product/202309/products/{x}/inventory/update` | `sea-inventory`（开关关闭） | — | 0 | — |
| `/logistics/202309/warehouses` | `tts-export`、`sea-inventory`、`tts-listing` | 少量 | 1/店 | 低 |
| `/product/202309/products` | `tts-listing` | 上架手动 | 每商品 1 次（写） | 写类参考 1–3/s，ttsCall 2.8/s ⚠️ |
| `/product/202309/images/upload` | `tts-listing` | 上架手动 | 每图 1 次（写） | 同上 ⚠️ |
| `/product/202309/categories/{x}/attributes` | `tts-listing` | 手动 | 少量 | 低 |
| `/product/202309/categories/{x}/rules` | `tts-listing` | 手动 | 少量 | 低 |
| `/product/202507/products/{x}/replicated_products` | `tts-listing` | 手动 | 少量 | 低 |
| `/authorization/202309/shops` | `tts-p0-probe`（授权/刷新） | 每日 `tts-token-refresh` | 1/店 | 低 |
| `/affiliate_seller/202412/conversation/{x}/messages` | `tts-p0-probe`（建联探测/私信） | 手动 | 少量 | 低 |
| `/affiliate_seller/202412/conversations` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202412/conversations/{x}/messages` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202412/conversations/messages/list/newest` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202508/conversations` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202508/target_collaborations` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202508/target_collaborations/{x}` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202508/target_collaborations/search` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202509/target_collaboration/{x}/link` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202605/target_collaborations/conflicts/check` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202607/creator_outreach/quota` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202608/conversations/group_counts` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202608/creator_outreach/records/query` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202608/marketplace_creators/search` | 同上 | 手动（文档：约 1 次/秒） | 少量 | 低 |
| `/affiliate_seller/202608/marketplace_creators/search/filter` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202608/target_collaborations/creator_promotion_details/query` | 同上 | 手动 | 少量 | 低 |
| `/affiliate_seller/202610/creator_outreach/eligibility/check` | 同上 | 手动 | 少量 | 低 |

### 3.3 其他外部服务（不受 TikTok 限额约束，列出供排查）

| 服务 | 调用方 | 触发 | 备注 |
|---|---|---|---|
| 飞书开放平台 `open.feishu.cn` | `feishu-read*`、`feishu-writeback`、`attribution-feishu`、各 cron 机器人通知 | 每晚 23:00 同步、19:00 授权回写、手动 | 读表按人拆请求并发 3；单函数 150s 墙钟 |
| 千易 `open.qianyierp.com`、顶妙 `gogo.topwms.com` | `sea-inventory` | 每日 2 次 | 未见限额文档 |
| ECO 后台 | `src/routes/api/public/hooks/eco.ts` | 余额预警每日 10:00 | — |

---

## 4. 定时任务时间线（UTC；同一时刻重叠的要看是否共用桶）

| 任务 | 时间（UTC） | 北京时间 | 外部接口 | 共用桶 |
|---|---|---|---|---|
| `creator-orders-step` | 每 5 分钟（每次 ≤25s） | — | BC report / campaign；Shop analytics 视频 | BC 应用桶；Shop 各店 |
| `tts-daily-sync` | 每小时 :17（≤8 分钟） | — | Shop 订单 / 财务（PH、TH） | Shop PH、TH |
| `reviews-nightly` | 16:35 / 17:35 / 18:35 | 00:35 / 01:35 / 02:35 | Shop analytics 商品 | Shop 全部店 |
| `feishu-sync-nightly` | 15:00 | 23:00 | 飞书 | — |
| `attribution-snapshot-nightly` | 15:30 | 23:30 | 无外部 | — |
| `authorize-daily-1900-bjt` | 11:00 | 19:00 | BC `/tt_video/authorize/` + 飞书 | BC 应用桶 |
| `balance-alert-daily` | 02:00 | 10:00 | BC 余额 / 报表 + ECO | BC 应用桶 |
| `sea-inventory-day` / `-night` | ⚠️ 具体时间未在仓库 migration 中写死（库内 cron.job） | — | Shop 订单/库存 + 千易/顶妙 | Shop SEA 店 |
| `tts-token-refresh` | 21:17 | 05:17 | Shop 授权 | — |
| `gmv-max-sync` | 已暂停（`GMV_MAX_SYNC_PAUSED`） | — | — | — |

**重叠点**：
- 每小时 :15–:25：`creator-orders-step`（BC）与 `tts-daily-sync`（Shop PH/TH）同时跑，**不同桶，互不影响**。
- 00:35–03:00 北京：`reviews`（Shop analytics，约 2.8/s/店）与 `creator-orders` 补名（Shop analytics 视频，无间隔）**同店同类接口叠加** ⚠️。补名只在有新 VID 时调用，量小。
- 19:00 北京：自动授权（BC）与 `creator-orders-step`（BC）同桶，但不是同一个接口（授权 vs 报表），按接口分别计数，不叠加。
- 白天手动：「达人出单 立即刷新」+ 定时同步 + 素材成效对账同时跑时，**`/gmv_max/report/get/` 三路串行叠加可能超过 240 QPM** 🔴。

---

## 5. 静默失败风险清单（会不会「看起来正常但缺数据」）

| # | 场景 | 现在的表现 | 是否静默 | 建议 |
|---|---|---|---|---|
| R1 | BC 报表触发 240 QPM → 等 5 分钟 | `ttGet` 退避约 45s 后报错；达人出单该「户×天」记到 `co_state.last_error`，**连续 2 次失败后跳过该单元**，当小时这户这天不更新 | 🔴 半静默：页面「同步状态」表能看到，但没有飞书提醒；下一小时会重新抓（今天和前两天都会重抓，所以 3 天内补齐） | ①（已做）每小时重抓近 3 天兜底 ②建议：`co_state` 有错误超过 3 小时发飞书 ③手动刷新时页面提示「定时同步正在进行」 |
| R2 | `ttGet` 无全局限速，多路并发 | 每路串行，路数 = 同时在跑的功能数 | ⚠️ | 新增批量 BC 功能必须串行，并登记到本表；如三路叠加常态化，改成 DB 记录每分钟调用数的全局令牌桶 |
| R3 | 不读 `Retry-After` | 退避时间固定 | 否（报错可见） | Shop 侧可在 `ttsCall` 读 `Retry-After`，改动小，下次动 tts.ts 时顺带做 |
| R4 | 达人出单补名 `ttsGet` 无间隔 | 被限流时该站点本轮停止补名，记到返回报告；未查到的 VID **不写 checked_at**，下轮重查 | 否（只是延后） | 量大时加 350ms 间隔 |
| R5 | `reviews` 单商品失败 | 记前 20 条错误到 `review_shops.last_error`，cron 有错误会发飞书；该商品当天无快照 → 累计差分把两天的新增评价算到次日 | ⚠️ 半静默：日粒度错位一天，总数不丢 | 维持；如出现失败，看飞书 |
| R6 | `tts-export` 每日入库限流 | 有报错发飞书，下轮从游标续跑 | 否 | — |
| R7 | 首页素材授权 24 并发 | 超 10 QPS 时部分条目 5 次重试后显示「API错误」 | 否（结果行可见） | 如常出现，把 `AUTH_MAX_CONCURRENT` 3→2 或 `ADV_CONC` 8→4 |
| R8 | BC 报表「Internal service timed out」（大户） | 不是限流；达人出单已改为二分批次重试 | 否 | — |

---

## 6. 每次改动的核对清单

1. 跑 `bash tools/check-api-limits.sh`：列出代码里有、本文没登记的接口路径 → 补登记表（调用方、触发、每次调用量、峰值）。
2. 新增**定时任务**：填 §4 时间线，看同一时刻是否与同桶任务叠加。
3. 新增**批量/循环调用**：BC 必须串行（复用 `ttGet`），估算 QPM，加上 §4 同时段其他任务后不超过 `/gmv_max/report/get/` 240 QPM、其他接口 600 QPM；Shop 复用 `ttsCall`（≥350ms 间隔），Analytics 类按单店 ≤1 次/秒设计。
4. 失败处理：限流失败必须**写进状态表并在下一轮重试**，或**发飞书**，不允许只 `console.error`（Edge Function 日志负责人无权限看，等于静默）。
5. 改完在本文「最后更新」写版本号。

---

## 7. 错峰与优化方案（1127.347 提出，未实施；⚠️ 定时任务实际时间以库内 `cron.job` 为准，AI 只读账号无权读 cron schema）

### 7.1 原则
- **BC 与 Shop 是两套额度，互不影响**；BC 内部按「接口」分别计数（授权 `/tt_video/authorize/`、余额、报表互不影响）。真正需要错开的只有：①同一 BC 接口被多路同时调用；②同一店铺的 Shop 同类接口（Analytics / 订单财务）被多路同时调用。
- 错峰优先用「分钟槽」：每小时内各任务占固定分钟段，手动操作用「通道锁」排队，不靠运气。

### 7.2 每小时分钟槽（建议）

| 分钟 | BC `/gmv_max/report/get/` | Shop 订单/财务 | Shop Analytics |
|---|---|---|---|
| :00–:14 | 达人出单同步（定时） | — | — |
| :17–:25 | （空，留给手动） | `tts-daily-sync`（现状不变） | — |
| :30–:44 | 达人出单同步续跑 | — | 北京 00:35/01:35/02:35 `reviews`（现状不变） |
| :47–:57 | — | — | 达人出单补名（**改**：现在同步完立刻补，可能撞 reviews） |

每日任务（现状，不建议改，均与上表不同桶或已错开）：19:00 北京授权（BC 授权接口）、10:00 余额（BC 余额/综合报表）、23:00 飞书、23:30 归因快照（无外部接口）、05:17 token 刷新。

### 7.3 改动清单（按风险分类）

**低风险可直接改（不改数字口径，只改调用节奏/告警）**
| # | 改动 | 解决 | 涉及 |
|---|---|---|---|
| O1 | 达人出单补名只在每小时 :47–:57 跑；视频 Analytics 调用间隔 1 秒（文档 Analytics 参考 ≤1/s） | 补名与 `reviews` 同店 Analytics 叠加；`ttsGet` 无间隔 | `creator-orders-cron.ts`、`creator-orders.server.ts`（需 Publish） |
| O2 | **BC 报表通道锁**：`co_settings` 加 `lock_holder / lock_until`；定时步与页面「立即刷新」抢同一把锁，拿不到就显示「定时同步进行中 x/87」并跟随进度，不再另起一路 | R2 的主要来源：手动+定时两路同时扫 87 个单元，BC 调用翻倍、同一行重复写 | 新 migration + 上述两文件 |
| O3 | 达人出单 `co_state` 某单元连续失败超过 3 小时 → 飞书一条（每天每户最多 1 条） | R1 半静默 | `creator-orders-cron.ts` |
| O4 | `ttsCall` 读 `Retry-After`；同一店首次遇 36009002 后本次调用把间隔从 350ms 升到 1000ms | Shop 限流时更快恢复，reviews 不用整体降速 | `_shared/tts.ts`（🔧 需 Lovable 部署所有引用它的函数：reviews、tts-export、sea-inventory、tts-listing、tts-p0-probe） |

**需负责人拍板（影响时效或操作速度）**
| # | 改动 | 代价 |
|---|---|---|
| D1 | 达人出单前天（SG-2）只在每 6 小时刷一次，今天/昨天仍每小时 | 每小时 BC 调用约减 1/3；前天的晚到花费最迟 6 小时更新（官方：花费最多晚 11 小时） |
| D2 | 达人出单定时步改为每 2 分钟（现 5 分钟），配合 :00–:14、:30–:44 槽 | 一轮更快跑完（现估约 50–60 分钟 ⚠️，可能拖到下一小时）；BC 每分钟峰值不变（仍单路串行） |
| D3 | BC 全局令牌桶：DB 记每分钟 `/gmv_max/report/get/` 调用数，≥180 次/分钟（240 留 25% 余量）时所有调用方等待 | 彻底解决多路叠加（含素材成效对账）；改 `_shared/tiktok.ts`，需部署所有 BC 函数，每次请求多一次 DB 往返（约 50ms） |
| D4 | 首页素材授权并发 3 路 × 8 户 → 2 路 × 5 户（最多 10 并发 ≈ 默认 10 QPS） | 手动授权变慢约 2 倍 |
| D5 | `reviews` 是否把 Analytics 降到 1 次/秒 | ❌ 不建议：PH 734 + TH 635 + VN 437 等约 2,600 次 ≈ 43 分钟，超出三个 8 分钟窗口；实测 2.8/s 未限流，用 O4 自适应即可 |
