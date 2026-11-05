# ads-auth 扩展：联盟达人外联（定向计划 + 私信）— 开发交接文档

> 版本：2026-11-05。用途：在 Claude Code（Web）中挂载仓库 `yunge008/ads-auth` 后，把本文件作为第一条消息的附件/正文，按本文执行。
> 业务口径已由项目负责人（Yunge）全部确认，**不要再改业务规则**；技术细节可自行决定，但遇到下文「需负责人决定」的情况必须先问。

---

## 0. 开工须知（必读）

1. 先读仓库 `AGENTS.md` → `docs/ARCHITECTURE.md` → `docs/PLAN.md`，遵守：**直接在 `main` 开发和推送，禁止新建分支/PR**；开工前在 PLAN.md 认领任务，完工后更新 PLAN.md、追加 WORKLOG.md。
2. 部署：项目由 Lovable 托管、与 GitHub `main` 双向同步。新增数据库 migration、Edge Function 部署、Supabase secrets 需要负责人在 Lovable 里手动执行 → 每完成一个阶段，在回复末尾单列「待人工：执行哪些 SQL / 部署哪些函数 / 设置哪些 secret」，并按 `docs/MIGRATIONS.md` 台账规则登记。
3. **代码隔离**：本功能与现有广告授权、GMV MAX、GMV 归因是不同线路、不同 API。新建独立模块，**不复用、不修改** `supabase/functions/_shared/tiktok.ts` 及任何 `attribution-*`、`gmv-max-*`、`feishu-*` 函数和归因相关表。现有 GMV 归因正在并行验收，不能被影响。
4. 负责人不懂技术：给他的提问必须带完整情景和具体例子，所有待决问题一次问完；回复用中文，结论先行。

---

## 1. 目标

BD 上传达人名单（Excel），选商品和佣金，系统通过 TikTok Shop Open API：
1. 创建**定向计划**（Target Collaboration）邀请这些达人；
2. 发送**站内私信**（Seller–Creator IM），3 天未回复自动跟进 1 次；
3. 持续跟踪每个达人：已邀请 → 已回复 → 已接受计划 → 已申请样品 → 样品已发货 → 已发视频 → 已出单；达人回复时用飞书应用机器人**私聊**通知对应 BD。

首批店铺：**PH、TH（跨境店）**。APP 当前只开通了东南亚市场（MY/PH/SG/TH/VN，本地+跨境商家）；先用 PH、TH 搭建测试，再扩 MY/SG/VN；MX 等 APP 加墨西哥市场后再接。

---

## 2. 已确认业务规则（不得更改）

| # | 规则 |
|---|---|
| R1 | **达人归属规则不变**：系统发出的邀请/私信**不算认领**；达人回复并由 BD 在飞书登记建联才有效。系统**不写** `creator_registry` / `creator_ownership` / 飞书建联表，只提醒 BD 去登记。 |
| R2 | **佣金审批**：任一商品自然佣金 > 20% 或广告佣金 > 6% → 不能提交，需输入审批密码。所有店铺共用一个密码，管理页可修改；只存哈希；每次放行写审批日志（批次、商品、自然/广告佣金、提交人、时间）。**服务端强制校验**，前端只做提示。 |
| R3 | **名额不足**：按 Excel 顺序发到本周名额用完；剩余标「名额不足未发」，下周可一键重发。已建联达人（回过消息/接过邀请/挂过商品）不占名额，照常发送。 |
| R4 | **私信条数**：达人回复前系统最多发 2 条（首发 1 + 跟进 1；平台上限 5）。 |
| R5 | **自动跟进**：首发 3 天后仍未回复 → 自动发 1 次跟进；跟进模板在群发时与首发模板一起设置。达人已回复则取消跟进。 |
| R6 | **防重复外联**：同一店铺同一达人 15 天内已被**其他 BD** 通过本系统外联过 → 拦截不发（结果表注明「X 月 X 日已被 某BD 外联」）；超过 15 天且该达人未回复 → 允许。只防重复骚扰，与归属无关。 |
| R7 | **计划冲突**：达人的某商品已在其他有效定向计划里 → 保留旧计划，该达人跳过该商品；批次完成后给 BD 一份汇总报告（达人、商品、所在计划、发起人、佣金）。 |
| R8 | **文案**：模板库按站点预置（PH 英文、TH 泰文；首发/跟进各若干套）；BD 可在模板基础上修改并另存为新模板；可选历史模板。每条私信记录所用模板 ID + 版本，按 站点×模板 统计发送数、回复率、接受率、申样率、出单率。 |
| R9 | **可见范围**：BD 只看自己的批次、达人、回复；负责人和管理员看全部。 |
| R10 | **默认值**：定向计划默认 2 个月后结束；默认允许申请样品，申样由 BD 在店铺后台人工审核（系统不自动审样）；店铺联系方式每店一个，由管理员配置。 |
| R11 | **发送身份**：私信在达人端显示为店铺，不区分 BD；系统内记录操作人账号。 |
| R12 | **回复通知**：约每 30 分钟检查新回复 → 飞书应用机器人私聊对应 BD（「TH 达人 xxx 已回复：…… 请跟进并登记建联」）；同一达人 30 分钟内多条合并。私聊失败（无权限/不在应用可用范围）→ 回退到指定群 @ 该 BD，并在管理页标出私聊失败的同事。 |
| R13 | **计划拆分**：一个定向计划最多 50 个达人、100 个商品，超出自动拆分；命名 `{站点}-{首个商品SKU或ID}-{YYYYMMDD}-{BD}-{序号}`，如 `TH-AR141-20261105-林丽洪-01`。 |
| R14 | **外联方式**：只发定向计划 / 只发私信 / 两者都发（默认两者都发）。两者都发时，私信内含该计划的邀请链接（Generate Target Collaboration Link）；P0 若确认 API 支持直接发计划卡片，则改用卡片。 |

---

## 3. 用户与入口

- **登录**：每个同事一个账号，沿用 ads-auth 现有账号/口令体系（`app_accounts` + 按 tab 授权），新增权限 tab `outreach`（BD）与 `outreach_admin`（负责人/管理员）。账号禁用后立即不能登录、不能发送；删除=软删除，历史记录保留。账号需维护：可用店铺、飞书邮箱或手机号（用于私聊通知）。
- **同事工作入口：Chrome 插件优先（MV3）**，向导式「下一步」：① 选店铺 → ② 上传 Excel → ③ 检查结果（可发/不可发+原因、本周名额）→ ④ 选商品与佣金 → ⑤ 选首发+跟进模板并预览 → ⑥ 确认发送（超佣金线在此输密码）→ ⑦ 发送结果。另有「我的批次」「待跟进回复」列表。**同时提供同功能网页版**（插件装不上时用）。插件与网页共用同一后端和账号；插件代码放仓库独立目录（如 `extension/`），不影响 Lovable 构建。
- **管理页面（网页）**：同事账号新增/禁用/启用/删除、可用店铺、飞书账号；群发结果与记录看板（站点×同事×批次×模板×日期：发送数、失败数及原因、回复/接受/申样/出单，可下钻到达人，可导出 Excel）；模板库；审批密码修改与审批日志；店铺授权状态。
- Excel 列：`站点, 达人账号(@后handle), 负责BD, 备注`；一个文件可含多站点；重复账号去重。

---

## 4. TikTok Shop API

### 4.1 与现有接入的区别
现有只接 Business API（`business-api.tiktok.com/open_api/v1.3`，Header `Access-Token`）。本功能用 Shop Open API：Host `open-api.tiktokglobalshop.com`，需 `app_key` + `timestamp` + HMAC-SHA256 `sign`、Header `x-tts-access-token`、Query `shop_cipher`；授权入口 `services.tiktokshop.com/open/authorize`。新建 `_shared/tts.ts` 实现签名、限速、退避、错误码映射。

### 4.2 APP 现状（负责人截图，2026-11-05）
- Partner Center → 应用「内部开发」（自定义，TikTok Shop 商家类），状态开启；目标卖家：马来西亚、菲律宾、新加坡、泰国、越南（本地商家；跨境商家（中国））。
- 重定向链接当前为 `https://tiktok-token-grabber.lovable.app`（另一个项目）。**需负责人决定**：能否添加 ads-auth 的回调地址；若只能填一个，是改地址还是沿用 token-grabber 拿到的授权。先在 Partner Center 查证是否支持多个回调地址，再带着具体选项问负责人。
- App Key/Secret 由负责人通过 Supabase secrets 设置（`TTS_APP_KEY`、`TTS_APP_SECRET`），不得写入代码或提交到仓库。

### 4.3 接口清单（Affiliate Seller API）

> **2026-11-05 更新（P0，claude）**：全部接口的路径、方法、版本、scope 已从 Partner Center 官方文档逐个拉取核对，原表「未核验/待确认」项全部有了官方路径。
> 「文档已核验」≠「实测通过」：实测结果见 `docs/OUTREACH_P0.md` §4，待两店跑完后再把本表「实测」列补上。

| 用途 | 接口 | 方法 + 路径 | Scope | 文档 | 实测 |
|---|---|---|---|---|---|
| 店铺列表/shop_cipher | Get Authorized Shops | GET `/authorization/202309/shops` | seller.authorization.info | 已核验 | 待测 |
| handle→open_id | Search Creators in Creator Marketplace | POST `/affiliate_seller/202608/marketplace_creators/search`（query `page_size`=12 或 20；body `keyword` 匹配 username/昵称；返回 `creator_open_id`） | seller.creator_marketplace.read | 已核验 | 待测 |
| 筛选项 | Get Creator Marketplace Advanced Search Filters | POST `/affiliate_seller/202608/marketplace_creators/search/filter` | seller.creator_marketplace.read | 已核验 | 待测 |
| 达人表现 | Get Marketplace Creator Performance | GET `/affiliate_seller/202608/marketplace_creators/{creator_user_id}` | seller.creator_marketplace.read | 已核验 | — |
| 周名额 | Get Weekly Creator Outreach Quota | GET `/affiliate_seller/202607/creator_outreach/quota` | seller.affiliate_collaboration.read | 已核验 | 待测 |
| 资格预检 | Check Creator Outreach Eligibility | POST `/affiliate_seller/202610/creator_outreach/eligibility/check`（≤100 人/次） | seller.affiliate_collaboration.read | 已核验 | 待测 |
| 外联记录 | Get Weekly Creator Outreach Records | POST `/affiliate_seller/202608/creator_outreach/records/query`（page_size ≤50） | seller.affiliate_collaboration.read/write | 已核验 | 待测 |
| 创建定向计划 | Create Target Collaboration | POST `/affiliate_seller/202508/target_collaborations` | seller.affiliate_collaboration.write | 已核验 | 待测 |
| 更新定向计划 | Update Target Collaboration | PUT `/affiliate_seller/202508/target_collaborations/{id}` | seller.affiliate_collaboration.write | 已核验 | — |
| 计划详情 | Query Target Collaboration Detail | GET `/affiliate_seller/202508/target_collaborations/{id}` | seller.affiliate_collaboration.read | 已核验 | 待测 |
| 计划列表 | Search Target Collaborations | POST `/affiliate_seller/202508/target_collaborations/search`（`collaboration_status` 必填） | seller.affiliate_collaboration.read | 已核验 | 待测 |
| 删除计划 | Remove Target Collaboration | DELETE `/affiliate_seller/202409/target_collaborations/{id}` | seller.affiliate_collaboration.write | 已核验 | — |
| 冲突检查 | Check Target Collaboration Conflicts | POST `/affiliate_seller/202605/target_collaborations/conflicts/check` | seller.affiliate_collaboration.write | 已核验 | — |
| 冲突处理 | Resolve Target Collaboration Conflicts | POST `/affiliate_seller/202605/target_collaborations/conflicts/resolve` | seller.affiliate_collaboration.write | 已核验 | — |
| 计划内达人推广明细 | Query Creator Promotion Details in Target Collaboration | POST `/affiliate_seller/202608/target_collaborations/creator_promotion_details/query` | seller.affiliate_collaboration.read/write | 已核验 | — |
| 邀请链接 | Generate Target Collaboration Link | POST `/affiliate_seller/202509/target_collaboration/{id}/link`（注意 target_collaboration 单数） | seller.affiliate_collaboration.write | 已核验 | 待测 |
| 会话 | Get or Create Creator Conversation | POST `/affiliate_seller/202508/conversations`（body `creator_open_id`） | seller.affiliate_messages.write | 已核验 | 待测 |
| 发私信 | Send IM Message | POST `/affiliate_seller/202412/conversations/{conversation_id}/messages`；`msg_type` ∈ TEXT / PRODUCT_CARD / **TARGET_COLLABORATION_CARD** / FREE_SAMPLE_CARD / IMAGE / CRM_TEXT_WITH_IMAGE_CARD / CRM_TEXT_WITH_PRODUCTS_CARD；`content` 为 JSON 字符串，TEXT ≤2000 字符 | seller.affiliate_messages.write | 已核验 | 待测 |
| 聊天记录 | Get Creator Conversation Messages | GET `/affiliate_seller/202412/conversation/{conversation_id}/messages`（conversation 单数；page_size 1–20） | seller.affiliate_messages.write | 已核验 | 待测 |
| 会话列表 | Get Conversation List | GET `/affiliate_seller/202412/conversations`（page_size 1–50） | seller.affiliate_messages.write | 已核验 | 待测 |
| 最新未读 | Get Latest Unread Messages | GET `/affiliate_seller/202412/conversations/messages/list/newest` | seller.affiliate_messages.write | 已核验 | — |
| 标记已读 | Mark Conversations as Read | POST `/affiliate_seller/202412/conversatons/read`（官方路径就拼成 conversatons，实测确认） | seller.affiliate_messages.write | 已核验 | — |
| 会话分类计数 | Get Inbox Category Counts | GET `/affiliate_seller/202608/conversations/group_counts` | seller.affiliate_messages.write | 已核验 | — |
| 会话状态 | Update Conversation Status | POST `/affiliate_seller/202608/conversations/{conversation_id}/status` | seller.affiliate_messages.write | 已核验 | — |
| 上传图片 | Upload Message Image V2 | POST `/affiliate_seller/202608/media/upload`（旧版 `/202511/images/upload`） | seller.affiliate_messages.write | 已核验 | — |
| 样品申请 | Search Sample Applications | POST `/affiliate_seller/202508/sample_applications/search` | seller.affiliate_collaboration.read | 已核验 | — |
| 审样（本项目不用，R10 人工审） | Review a Sample Application | POST `/affiliate_seller/202507/sample_applications/{application_id}/review` | seller.affiliate_collaboration.write | 已核验 | — |
| 样品发货 | Search Sample Application Fulfillments | POST `/affiliate_seller/202409/sample_applications/{application_id}/fulfillments/search` | seller.affiliate_collaboration.read | 已核验 | — |
| 出单 | Search Seller Affiliate Orders | POST `/affiliate_seller/202410/orders/search` | seller.affiliate_collaboration.read | 已核验 | — |

已知错误码：
- Send IM：`16030100` 对该达人消息配额用尽；`16030101` 店铺异常或等级未达 GMV 门槛；`16032001` 达人与店铺区域不一致；`45101004` 每日 10000 次调用上限。
- Get or Create Conversation：`16030002` 店铺 IM 名额用尽；`16030003` 未达联盟 GMV 门槛；`16030009` 测试账号隔离；`45101021` 达人隐私限制。
- Create Target Collaboration：`16024016` 达人已绑定店铺账号；`16024019` 名额不足；`16024021` 达人粉丝数超档位上限；`16024022` 达人×商品已在其他计划（冲突）；`50001702` 达人/商品不可用；`50001703` 含敏感词。
- 限流：HTTP 429 或业务码 `36009002`（Rate limits 文档）。

佣金单位（文档已核验，待实测对照后台显示）：`target_commission_rate` = 万分比（`1000` = 10%，`3587` = 35.87%，最小 `100` = 1%）；**广告佣金字段 = `shop_ads_commission_rate`**（同单位，选填；不填时广告订单按公开计划的 Shop Ads 佣金或本计划标准佣金计）。

### 4.4 平台限制（来自 Seller University）
- 私信与定向邀请**共用**每周新外联名额，按店铺近 30 天 GMV 分档、每周刷新；与 BD 在后台手工外联共用；API 无独立名额。已建联达人不占名额；同一周对同一达人多次发送只计一次。
- 达人回复前最多 5 条消息。
- 定向佣金 1%–80%，覆盖公开计划佣金；修改定向佣金 5 天后生效。

---

## 5. 数据模型（新表，前缀 `tts_` / `outreach_`）

| 表 | 关键字段 |
|---|---|
| `tts_shops` | shop_id, shop_cipher, region, shop_name, seller_type(本地/跨境), access_token, refresh_token, access_expires_at, refresh_expires_at, scopes, contact_info, status |
| `tts_creators` | region, username(handle 规范化), open_id, nickname, level, resolve_status(OK/NOT_FOUND/AMBIGUOUS), resolved_at — handle→open_id 缓存 |
| `outreach_templates` | id, region, kind(FIRST/FOLLOWUP), name, version, content, based_on_id, created_by, active |
| `outreach_batches` | id, shop_id, created_by, mode(TC/IM/BOTH), products json(商品ID+自然/广告佣金), first_template_id, followup_template_id, end_time, free_sample, status, quota_snapshot json, report json(R7 汇总) |
| `outreach_batch_creators` | batch_id, handle, open_id, owner_bd, precheck_status + reason, send_status, tc_id, conversation_id, skipped_products json |
| `target_collabs` | tc_id, shop_id, batch_id, name, products json, end_time, status, conflicts json |
| `im_conversations` | conversation_id, shop_id, open_id, last_msg_at, unread, unanswered_count, last_reply_at |
| `im_messages` | msg_id, conversation_id, direction(OUT/IN), msg_type, content, template_id, template_version, sent_by, error_code, created_at |
| `outreach_events` | shop_id, open_id, batch_id, event(INVITED/REPLIED/ACCEPTED/SAMPLE_REQ/SHIPPED/POSTED/ORDERED), ts, ref_id |
| `commission_approvals` | batch_id, product_id, natural_rate, ad_rate, submitted_by, approved_at |
| `outreach_settings` | approval_pass_hash, followup_days(3), dedupe_days(15), max_msgs_before_reply(2), default_end_months(2), natural_cap(20), ad_cap(6), fallback_feishu_chat_id |
| 账号扩展 | 在现有账号上增加：feishu_email/mobile、allowed_shops、disabled_at、deleted_at（如现有表不便扩展，新建 `outreach_users` 关联） |

审批密码哈希也可放 `outreach_settings`（负责人要求后台可改密码，所以存表而非 secret）。

---

## 6. 后端函数（Supabase Edge Functions，前缀 `tts-` / `outreach-`）

- `tts-oauth-init` / `tts-oauth-exchange` / `tts-token-refresh`(cron) / `tts-shops-sync`
- `outreach-precheck`：Excel 行 → 规范化去重 → handle 解析（缓存优先；搜索结果 username 完全相等才接受）→ eligibility（≤100/次）→ R6 防重复 → R7 冲突预判 → 名额读取与 R3 截断 → 返回逐人结果
- `outreach-submit`：R2 佣金校验（服务端）→ 按 50 人拆分创建计划（R13）→ 处理冲突（R7）→ 生成邀请链接 → 逐个 get-or-create 会话并发首发（R4、R14）→ 写结果
- `outreach-followup`(cron，每小时)：首发 ≥3 天且未回复、未发过跟进 → 发跟进（R5）
- `outreach-im-sync`(cron，30 分钟)：拉会话/未读 → 写 im_messages、REPLIED 事件 → 飞书私聊通知（R12）
- `outreach-funnel-sync`(cron，每日)：计划详情（接受）、样品申请/发货、联盟订单 → outreach_events
- `outreach-admin`：账号、模板、设置、审批密码修改、看板查询、Excel 导出
- 飞书私聊：用负责人已有的飞书**应用机器人**（tenant_access_token，发消息接口以 email/手机号对应的用户为接收方）；可参考现有 `_shared/feishu.ts` 的 token 获取方式，但新功能代码单独写，不改原文件。

限速：沿用现有经验（≈3 QPS、429/频控指数退避、单次函数有时间预算并可续跑）。所有写操作幂等（批次+达人唯一键），重试不得重复发消息或重复建计划。

---

## 7. 分阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 实测** | 与负责人一起：确认回调地址方案；APP 勾选 scope 并发布；授权 PH、TH；用 API 测试工具（或最小脚本）逐店调：名额、搜达人、资格检查、创建计划（1 达人 1 商品）、生成邀请链接、取/建会话、发 1 条消息 | 两店各接口 code=0；查清 commission_rate 单位、广告佣金字段、open_id 获取、TEXT 消息格式、是否有计划卡片消息类型、各未核验接口路径；每店 10 个已知 handle 解析成功率。结果写进 `docs/` 并更新本文 §4.3 |
| P1 基础层 | `_shared/tts.ts` 签名、OAuth、token 自动刷新、`tts_shops`、店铺授权状态页 | 签名单测通过；token 到期前自动刷新 |
| P2 账号与管理 | 账号扩展、outreach 权限 tab、管理页（账号/模板/设置/密码） | 禁用后立即无法调用任何 outreach 接口 |
| P3 定向计划 + 首发 | precheck + submit + 网页版向导 + 结果表 + R7 汇总报告 | 50 人批次一次成功；R2/R3/R6/R7 各造一个用例通过；后台计划与库内一致 |
| P4 跟进与回复通知 | followup cron、im-sync、飞书私聊+群回退 | 3 天跟进准时且不重复；回复 30 分钟内私聊到 BD |
| P5 漏斗与看板 | funnel-sync、看板、导出、模板效果统计 | 抽 10 个达人与店铺后台逐项一致 |
| P6 Chrome 插件 | MV3 插件实现同一向导，复用后端 | 插件与网页提交结果一致 |
| 扩展 | MY/SG/VN；MX（APP 加市场后）；达人广场条件筛选（负责人后续给条件） | 每新增一店先过 P0 清单 |

---

## 8. 需负责人提供 / 操作

1. Partner Center：APP 勾选权限（达人广场读取、联盟合作读取/管理、联盟消息管理）并发布；回调地址按 §4.2 决定后配置。
2. 在 Lovable/Supabase 设置 secrets：`TTS_APP_KEY`、`TTS_APP_SECRET`；飞书应用机器人沿用现有凭据（确认已开「以应用身份发消息」权限，BD 在应用可用范围内）。
3. 用 PH、TH 店铺账号完成授权。
4. 提供：每店联系方式、PH 英文/TH 泰文首发与跟进文案、初始审批密码、每店约 10 人测试名单、每个 BD 的飞书邮箱或手机号、回退通知群。

## 9. 风险提示（实施中注意）
- 名额与 BD 手工外联共用：看板显示本周剩余名额，避免系统批量发送挤占手工额度。
- 防 spam：外联有效性影响下周奖励名额，先小批量（≤50 人）试跑观察回复率。
- 文档版本变化快：接口失败率上升要告警，不要静默。
- 跨境店多站点 shop_cipher 不同，授权与调用按 店铺×站点 区分。
