# 达人建联与维护 SOP · 业务开发计划

> 2026-11-17 claude 起草，供开发排期。接口依据：Partner Center 文档（2026-11-05/16 拉取，见 `docs/OUTREACH_HANDOFF.md` §4.3、`docs/TTS_API_RESEARCH.md`）。
> 标注：✅ 接口有且已实测 ／ 📄 接口有、文档已核验未实测 ／ ❌ 无接口 ／ 🔒 写接口，当前被只读闸门拦截，需负责人逐条确认后放开。

## 0. 结论

1. **两个 SOP 的每一步都有官方接口支撑**，除了两处：
   - 「读取达人发布过的视频内容」只能拿到统计和样品带货视频，拿不到达人全部视频的文字或画面。
   - 「登记建联」写的是飞书，不在 TikTok 接口里。
2. **定制话术可以做**：素材来自达人数据（粉丝、GMV、类目、带货率、互动率）、聊天记录、与本店的合作历史（申样、出单、样品视频的描述和播放量），由 AI 生成草稿。
3. **最大的前置条件是写权限**：发私信、建会话、审样、发卡片目前都被只读闸门拦截。只有「定向计划新建/修改」已放行。见 §5，需要负责人逐条确认。
4. **与原交接规则冲突、属于变更的点**：
   - 系统审样（原 R10 为人工审）。
   - 系统登记建联（原 R1 为系统不写建联表）。
   - AI 自动回复。
   - 老达人维护话术。
   - 首发后跟进次数可能超过 R4/R5 的上限。

   以上都需要负责人拍板，见 §6。

## 1. 数据底座（两个 SOP 共用，先建）

| 表 | 内容 | 来源接口 | 更新方式 |
|---|---|---|---|
| `tts_creators` | 达人档案：handle、open_id、粉丝、GMV/视频GMV/直播GMV、GPM、类目分布、平均佣金、带货率、互动率、等级、近 30 天发视频数 | 📄 Search Creators in Creator Marketplace、📄 Get Marketplace Creator Performance | 建联时拉一次，老达人每 7 天刷新 |
| `creator_relationship` | 达人 × 店铺 关系状态（见 §1.1）、负责 BD、最近一次联系时间、最近一次回复时间、最近出单时间 | 汇总自下面各表 | 事件驱动 |
| `im_conversations` / `im_messages` | 会话与消息（方向、类型、内容、模板/AI 草稿 ID、发送人） | 📄 Get Conversation List、Get Creator Conversation Messages、Get Latest Unread Messages；**Webhook (33) New message listener** | Webhook 实时 + 每 30 分钟补拉 |
| `target_collabs` | 定向计划、商品、佣金、达人接受状态 | ✅ Search/Query Target Collaboration、📄 Query Creator Promotion Details | 每日 |
| `sample_applications` | 申样单：状态、商品 SKU、申样单号 order_id、运单号、履约状态、达人履约率 | 📄 Search Sample Applications；**Webhook (56) Sample Application Status Change** | Webhook 实时 + 每日补拉 |
| `sample_logistics` | 样品物流轨迹、签收时间 | 📄 Get Order Tracking（用申样 order_id）/ Get Logistics Tracking | 发货后每 6 小时，签收后停（申样单号能否直接查物流轨迹**未实测**，S0 第一项验证） |
| `sample_contents` | 样品对应的视频/直播：内容 ID、链接、描述文字、播放/点赞/评论、带货单数、发布时间 | 📄 Search Sample Application Fulfillments | 签收后每日 |
| `creator_orders` | 达人出单（SKU 级） | ✅ Search Seller Affiliate Orders（已在 `tts-export` 实现） | 每日 |
| `outreach_events` | 事件流：INVITED / REPLIED / TC_ACCEPTED / SAMPLE_REQ / SAMPLE_APPROVED / SHIPPED / DELIVERED / POSTED / ORDERED / FOLLOWED_UP | 由以上写入 | — |

### 1.1 达人关系状态机
`候选` → `已外联` → `已回复` → `已接计划` → `已申样` → `已审样` → `已发货` → `已签收` → `已发素材` → `已出单` → `老达人维护中`

- `已签收 + 7 天未发素材` → `待催素材`。
- `最近联系超过 X 天` → `待唤醒`。

## 2. SOP A：新达人建联（步骤 × 接口 × 实现）

| # | 步骤 | 接口 | 读/写 | 实现方式 | 人工介入 |
|---|---|---|---|---|---|
| A1 | 达人筛选 | 📄 Get Creator Marketplace Advanced Search Filters → 📄 Search Creators in Creator Marketplace（粉丝区间、GMV 区间、销量区间、类目、平均播放、互动率、平均佣金、带货率、近 90 天未邀请、是否快速成长等）→ 📄 Get Marketplace Creator Performance | 读 | 「筛选条件模板」（按站点保存）→ 结果入 `tts_creators`，按自定义打分排序（如 GPM×带货率×类目匹配） | BD 勾选名单 |
| A2 | 资格与名额预检 | 📄 Check Creator Outreach Eligibility（≤100 人/次）、📄 Get Weekly Creator Outreach Quota、Check Target Collaboration Conflicts（🔒 文档标 write scope，实际为检查） | 读 | 沿用交接文档 R3/R6/R7 | — |
| A3 | 建定向计划 | ✅ Create / Update Target Collaboration（**已放行**） | 写 ✅ | 已有 `add_to_tc` / outreach-submit 设计；R2 佣金审批、R13 拆分 | 超佣金线输密码 |
| A4 | 发首发私信 + 计划卡片 | 🔒 Get or Create Creator Conversation、🔒 Send IM Message（TEXT + TARGET_COLLABORATION_CARD） | 写 🔒 | AI 根据 A1 达人数据生成定制首发文案 → **BD 预览确认后发送**（第一期不全自动） | BD 确认文案 |
| A5 | 查看消息 | 📄 Get Conversation List / Messages / Latest Unread；Webhook (33) | 读 | 收到回复 → 写 `im_messages` → 飞书通知 BD（R12） | — |
| A6 | AI 回复 | 🔒 Send IM Message、🔒 Mark Conversations as Read | 写 🔒 | Claude API 读「聊天上下文 + 达人档案 + 本店商品/佣金 + 话术库」→ 生成回复草稿 + 意图分类（要样品 / 要别的商品 / 问佣金 / 拒绝 / 其他）。第一期：草稿进「待回复」列表，BD 一键发送或修改；稳定后对低风险意图（感谢、确认收货）开放自动发送 | 第一期全人工确认 |
| A7 | 追加/推送定向计划 | ✅ Update Target Collaboration（加商品/改佣金）或 Create；🔒 Send IM（发卡片） | 写 ✅+🔒 | 意图为「要其他商品」→ 系统按达人类目推荐商品 → BD 选 → 更新计划 + 发卡片 | BD 选商品 |
| A8 | 查看申样 | 📄 Search Sample Applications；Webhook (56) | 读 | 新申样实时入库，列表展示达人数据 + 履约率（`fulfillment_percentage`）+ `is_approvable` | — |
| A9 | 审批申样 | 🔒 Review a Sample Application | 写 🔒 | **规则引擎给建议**（如：粉丝 ≥ N、履约率 ≥ 60%、近 30 天发视频 ≥ M、同商品未重复申样）→ BD 一键通过/拒绝；第二期可对满足白名单规则的自动通过 | **变更点**：原 R10 为后台人工审 |
| A10 | 登记申样建联 | 飞书 Bitable 写入（非 TikTok 接口） | 写飞书 | 审样通过 → 预填飞书建联表一行（达人、BD、商品、申样单号）→ BD 确认提交 | **变更点**：原 R1 为系统不写建联表 |
| A11 | 追踪样品物流 + 提前预告 | 📄 Search Sample Applications（运单号/履约状态）→ 📄 Get Order Tracking（申样 order_id） | 读 + 🔒 Send IM | 发货时私信达人：运单号 + 预计到达 + 商品卖点（AI 按商品生成）；轨迹异常（滞留 > 3 天）提醒 BD | 模板确认后自动 |
| A12 | 签收后推荐脚本 | 签收事件（物流轨迹 DELIVERED）+ 🔒 Send IM | 读 + 🔒 | AI 生成脚本：商品卖点 + 本店该商品**出单最好的样品视频描述/播放数据**（来自 `sample_contents`、`creator_orders`）+ 达人风格（类目、直播/视频占比）。发私信，可附商品卡片 | 脚本库人工审核后自动发 |
| A13 | 一周后跟进素材 | 📄 Search Sample Application Fulfillments（是否已发内容）+ 🔒 Send IM | 读 + 🔒 | 签收 + 7 天仍无内容 → 发跟进话术（最多 N 次，间隔 X 天）；已发 → 发感谢 + 数据反馈，进入维护池 | 自动（规则确认后） |

## 3. SOP B：老达人跟进维护

| # | 步骤 | 接口 | 实现方式 |
|---|---|---|---|
| B1 | 识别老达人 | ✅ 联盟订单（出过单）、📄 申样记录、📄 会话列表（回复过） | `creator_relationship` 里「已出单」或「已发素材」的达人 |
| B2 | 计算「未联系天数」 | 📄 Get Conversation List（最近消息时间）+ `im_messages` | 最近一次双向互动距今 > X 天（按达人分层设不同 X：头部 14 天、腰部 30 天、尾部 60 天，可配置） |
| B3 | 拉最新数据做定制 | 📄 Get Marketplace Creator Performance（近期 GMV/视频数变化）、✅ 联盟订单（在本店的历史出单、最畅销 SKU）、📄 Fulfillments（历史样品视频表现） | 生成「达人简报」：在本店累计出单、最好的一条视频、近 30 天活跃度、适配的新品 |
| B4 | 生成并发送唤醒话术 | 🔒 Send IM（文字 + 新品卡片 / 定向计划卡片） | AI 按简报生成；第一期 BD 批量预览 → 一键发送 |
| B5 | 追加新品计划 | ✅ Update / Create Target Collaboration | 回复有意向 → 同 A7 |
| B6 | 效果回收 | 会话回复、计划接受、申样、出单 | 按 话术版本 × 达人分层 统计回复率/申样率/出单率，淘汰低效话术 |

注：已建联达人**不占每周新外联名额**（官方规则）。老达人维护不受名额限制，但仍受「达人回复前最多 5 条消息」的限制。

## 4. 定制话术：数据来源与边界

| 可用（接口能拿到） | 不可用 |
|---|---|
| 粉丝数、粉丝性别/年龄主分布、GMV（总/视频/直播）、GPM、类目 GMV 分布、平均佣金率、带货率（post_rate）、视频平均播放/点赞/评论/分享、互动率、近 30 天发视频数中位数、合作品牌数、达人简介（bio） | ❌ 达人全部视频的标题、文案、画面（无接口；只能拿到「带本店样品」的视频描述和数据） |
| 本店：样品视频的描述、链接、播放、点赞、评论、带货单数（Fulfillments）；联盟订单的内容类型/ID、出单 SKU | ❌ 视频画面理解：需另外下载视频再做多模态分析，属于另一个项目，不在本期 |
| 聊天上下文（Messages）、计划/佣金、商品卖点（商品详情接口） | — |

AI 接入：Supabase Edge Function 调 Claude API（新 secret `ANTHROPIC_API_KEY`），输入为结构化简报而非原始 JSON。每条草稿记录模型、提示词版本和输入摘要，便于复盘。**不把买家信息送给 AI。**

## 5. 需负责人逐条确认放开的写接口（当前被 `_shared/tts.ts` 只读闸门拦截）

| 接口 | 用途 | 风险 | 建议 |
|---|---|---|---|
| POST `/affiliate_seller/202508/conversations` Get or Create Conversation | 建会话（发信前必需） | 低；建会话本身不发消息 | 与 Send IM 一起放 |
| POST `/affiliate_seller/202412/conversations/{id}/messages` Send IM Message | 发私信、发卡片 | **高**：外发给达人，计入名额与 5 条上限 | 放开，但服务端强制：BD 确认标记、频控、5 条上限、防重复（R6） |
| POST `/affiliate_seller/202412/conversatons/read` Mark as Read | 标已读 | 低；会影响后台未读提示 | 放 |
| POST `/affiliate_seller/202608/conversations/{id}/status` Update Conversation Status | 会话分类 | 低 | 放 |
| POST `/affiliate_seller/202608/media/upload` Upload Message Image V2 | 私信图片 | 低 | 需要时放 |
| POST `/affiliate_seller/202509/target_collaboration/{id}/link` Generate TC Link | 邀请链接 | 低（已用卡片可不需要） | 可选 |
| POST `/affiliate_seller/202507/sample_applications/{id}/review` Review Sample Application | 审样 | **中**：直接产生发样成本 | 第一期仅「BD 点通过」时调用，不自动 |
| POST `/affiliate_seller/202605/target_collaborations/conflicts/check` Check Conflicts | 冲突检查 | 无（只检查） | 放 |
| POST `/affiliate_seller/202605/target_collaborations/conflicts/resolve` Resolve Conflicts | 处理冲突 | 中：会改动其他计划 | 暂不放 |

## 6. 与原规则的差异（需负责人确认，均为变更不是延续）

| 原规则（OUTREACH_HANDOFF.md） | 新需求 | 需决定 |
|---|---|---|
| R1 系统不写建联表 | 「登记申样建联」 | 审样通过后系统**预填**飞书建联表、由 BD 确认提交，还是全自动写入？归属规则是否随之改变？ |
| R10 申样由 BD 在店铺后台人工审 | 系统内审样 | 第一期 BD 在系统内点通过/拒绝？是否允许满足白名单规则的自动通过？ |
| R4/R5 回复前最多 3 条、3 天跟进 1 次 | 发货预告、签收脚本、一周催素材 | 这几条通常发生在达人已回复之后，不受 R4 限制；如果达人始终未回复，是否也发？ |
| 无 | AI 回复 | 第一期是否全部 BD 确认后发送（建议是）？ |
| 无 | 老达人维护 | X 天按达人分层设置的具体天数；每个达人每月最多唤醒几次？ |

## 7. 分期

| 期 | 范围 | 前置 | 验收 |
|---|---|---|---|
| S0 | 数据底座：达人档案、申样同步、物流轨迹、样品内容、会话只读同步，以及两个 Webhook 接收函数（公开端点、校验签名；需要在 AGENTS.md 注明鉴权例外） | 无写权限即可做 | 抽 20 个达人，与后台的申样、物流、内容逐项一致 |
| S1 | 达人筛选 + 打分 + 名单 → 定向计划（已放行）+ 首发私信（BD 确认） | §5 放开 Get or Create Conversation、Send IM | 小批量（≤50 人）实发，名额/上限/防重复各造一个用例 |
| S2 | 收件箱 + AI 回复草稿 + 意图分类 + 追加计划 | Claude API key | BD 采纳率、修改率统计 |
| S3 | 申样：查看 + 规则建议 + BD 审样 + 预填建联表 | §5 放开 Review、§6 R1/R10 决定 | 审样结果与后台一致 |
| S4 | 物流预告 + 签收脚本 + 7 天催素材（自动化规则） | 话术库审核 | 定时任务准时、不重复 |
| S5 | 老达人维护：分层 X 天、简报、唤醒话术、效果回收 | — | 回复率/出单率看板 |

入口：沿用交接文档的网页向导与 Chrome 插件。收件箱与审样建议做在网页上。

## 8. 风险
- Send IM 有每日 10000 次调用上限，单个达人回复前最多 5 条；超发可能影响下周外联名额（官方「外联有效性」）。先小批量试。
- Webhook 需要公开 URL，并在 Partner Center 配置；签名校验不能省。
- 官方接口版本更新快：本文路径以 2026-11 文档为准，开发每个接口前再实测一次。
- AI 话术可能触发敏感词（Create TC 有 `50001703` 敏感词错误），发送前需过敏感词检查。

## 9. 负责人决定（2026-11-17）
| 事项 | 决定 | 落地 |
|---|---|---|
| 发私信 | 放开（只读是内部规则，接口本身支持） | 1117.156 起闸门放行：建会话 POST `/conversations`、发消息 POST `/conversations/{id}/messages`、标已读 POST `/conversatons/read`。会话状态、上传图片、邀请链接、审样、删计划、冲突处理仍拦截 |
| AI 回复 | 第一期全部由 BD 确认后再发 | S2 按「草稿 → BD 确认 → 发送」实现 |
| 审样 | 先只给建议（推荐批准 / 待审核 / 不批准），看准确率再放开 | 1117.156：`tts-export` 新增 `kind=samples`，页面「申样审核建议」导出 xlsx（含理由与规则页）；**不调审样接口**。初版规则见 §9.1 |
| 飞书回写 | 允许写入单独专门的 sheet，格式与现有回写一致，不影响同事的 sheet | 用于每晚自动汇总（见 `docs/TTS_API_RESEARCH.md` §13.1）；sheet 名待负责人指定 |

### 9.1 申样审核建议初版规则（参数都可在请求里调整）
按顺序判断，命中即停：
1. **不批准**：平台标记不可审批（`is_approvable=false`）。
2. **不批准**：本店历史「已发样未履约」≥ 2 次。
3. **不批准**：平台履约率 < 30%。
4. **推荐批准**：履约率 ≥ 60%（或无记录），且 达人 GMV ≥ 100 或 粉丝 ≥ 5000。
5. 其余：**待审核**。

准确率验证：导出一批 → BD 照常人工审 → 对比建议与实际结果，按吻合率调整阈值。吻合率达到负责人要求后，再讨论放开审样接口。

## 10. 达人总表 + 归属标签（2026-11-17 负责人提出，新增范围）
| 项 | 方案 |
|---|---|
| 数据表 | `creator_master`：站点、handle、open_id、当前归属同事、归属状态（有效/到期）、归属到期日；`creator_owner_history`：同事、开始、结束、来源（飞书建联表 / 系统登记） |
| 归属规则 | **待负责人提供**（有效期多长、什么行为续期、到期后能否被他人认领） |
| 月度订单 | 两个来源可选：①飞书表（每晚刷新）；②联盟订单接口（已在 `tts-export`，可每晚同步 达人 × 月 × 订单数/GMV）。建议用②为主、飞书为核对 |
| 标签 | 归属同事 + 状态，如「李汝华-有效」「李汝华-到期」，由规则每晚重算 |
| 到期预警 | 每晚扫描 N 天内到期的归属 → 飞书私聊归属同事 |
| 查看方式 | **网页后台不需要插件**：达人总表可查、可筛选、可导出。**只有想在 TikTok 后台页面（IM 会话列表、达人广场）直接看到标签，才需要插件**：现有插件 `tiktok-plug-kol` 已在 IM 会话卡片注入「已发标签」，可用同一机制注入归属标签，标签从本后台接口读取（插件需新增本后台域名权限 + 口令）。已经在用插件发私信的同事升级插件即可 |
