# 联盟达人外联 · P0 实测记录

> 交接文档：`docs/OUTREACH_HANDOFF.md`（§4.3 接口表已按本次核对结果更新）。
> 状态：**文档核对已完成；`tts-p0-probe` 已部署、secrets 已设、`tts_shops` 已建（2026-11-10 负责人确认）；授权入口页已做；两店实测待授权后执行**（§3 步骤，结果填 §4）。
>
> 2026-11-10 负责人决定：D1 回调地址改为 `https://ads-auth.lovable.app/oauth/tts/callback`；D2 首发文字+卡片算 1 次，回复前上限 3 条（R4 变更）；D3 名额按等级分档，跳过名额用完等级的达人继续发其他人（R3 补充）。

## 1. 本次做了什么（2026-11-05，claude）

1. 从 Partner Center 官方文档（`partner.tiktokshop.com/docv2`，文档数据接口 `api/v1/document/*`）逐个拉取 Affiliate Seller 全部 50 个接口的路径 / 方法 / 版本 / scope / 参数 / 错误码，以及签名、授权、限流三篇开发指南。交接文档里「未核验 / 待确认」的接口全部找到官方路径，见 `OUTREACH_HANDOFF.md` §4.3。
2. `supabase/functions/_shared/tts.ts`：签名（HMAC-SHA256）、限速（≈3 QPS）、限流退避（429 / 36009002）、token 换取与刷新。**签名用官方文档的分步示例做单测，结果与官方给出的 sign 完全一致**（`_shared/tts.test.ts`，5 例通过）。
   - 写操作（建计划、发消息）只在「明确被限流拒绝」时重试，超时 / 5xx 不重试，避免重复建计划、重复发消息。
   - 已用假 app_key 对真实 Host 发请求：平台返回 `36009004 Invalid 'app_key'`，说明请求格式、签名参数位置被平台正常解析，只差真实凭据。
3. 新表 `tts_shops`（migration `20261105120000_tts_shops.sql`）：存店铺授权（shop_cipher、token、到期时间、scope、联系方式）。开 RLS 不建 policy，前端读不到 token。
4. Edge Function `tts-p0-probe`（仅管理员）：负责人在「API测试」页粘贴一行指令就能完成授权入库和全部 P0 实测，详见 §3。
5. 与现有广告授权 / GMV MAX / GMV 归因代码**零交集**：没有改动 `_shared/tiktok.ts`、任何 `attribution-*` / `gmv-max-*` / `feishu-*` 函数和归因表。

## 2. 文档核对发现（与交接文档不同或新增的点）

| # | 发现 | 影响 |
|---|---|---|
| F1 | 建计划接口官方最新版是 **202508**（交接文档写 202405） | 用 202508 |
| F2 | 佣金单位：`target_commission_rate` 万分比（1000=10%，最小 100=1%）；**广告佣金字段 = `shop_ads_commission_rate`**，同单位、选填 | R2 校验与提交按此换算；待实测对照后台显示 |
| F3 | 发私信支持 **`TARGET_COLLABORATION_CARD`**（计划卡片）和 `TEXT`（≤2000 字符） | R14 的前提「API 支持直接发计划卡片」文档上成立；待实测达人端显示效果。**卡片与文字是否算 2 条 → 见 D2** |
| F4 | 每周名额**按达人等级分桶**：quota 接口返回 `quota_details[]`（每档 `creator_levels` + 周期名额 + 奖励名额），资格检查逐人返回 `creator_level`、`is_creator_level_quota_available`、`is_connected`、`is_paired`、`is_creator_follower_count_threshold_met`、`is_blocked` | R3「按 Excel 顺序发到名额用完」在分档下有歧义 → 见 D3；「已建联不占名额」可直接用 `is_connected` / `is_paired` 判断 |
| F5 | 有官方冲突检查 / 处理接口（202605）；建计划失败时也会返回 `target_collaboration_conflicts` 与错误码 `16024022` | R7 可在提交前预检冲突，不必等建计划失败 |
| F6 | 邀请链接接口：POST `/202509/target_collaboration/{id}/link`（单数，非 `links/generate`） | — |
| F7 | 取/建会话：POST `/202508/conversations`，body `creator_open_id` | — |
| F8 | 平台有「新消息」webhook（Affiliate Seller #33）和「样品申请状态变化」webhook（#56） | R12 目前按 30 分钟轮询实现，不变；以后要「秒级」提醒可改 webhook（需要另配回调地址，届时再定） |
| F9 | Send IM 有每日 10000 次调用上限（`45101004`） | 远高于本项目量级，无影响 |
| F10 | 官方说明：APP 处于开发状态时线上卖家不能授权 | 若授权页报错，先确认 APP 状态（截图显示「开启」，应无问题） |
| F11 | 「标记已读」官方路径拼写为 `conversatons/read` | 实测时确认 |
| F12 | Partner Center 是否支持多个重定向地址：**官方文档未找到说明，未核验** | 见 D1 |

需要勾选的 scope（5 个）：`seller.authorization.info`、`seller.creator_marketplace.read`、`seller.affiliate_collaboration.read`、`seller.affiliate_collaboration.write`、`seller.affiliate_messages.write`（会话列表 / 聊天记录 / 发消息都只挂这一个 scope，没有单独的 read）。

## 3. 实测步骤（负责人在「API测试」页操作）

指令格式：`tts-p0-probe {JSON}`，粘贴到「API测试」页输入框后点运行，把输出整段复制给 Claude。

1. 授权入库（网页操作，不用敲指令）：设置 → **TikTok Shop 授权** → 「打开授权链接」或「复制授权链接」粘贴到指纹浏览器 → 登录卖家账号并同意 → 自动跳到 `/oauth/tts/callback`（若该浏览器没登录本工具，先登录，页面会自动完成）→ 列表里出现 PH、TH 店铺。
   - 回调页没自动完成：复制跳转后的完整链接，回到设置页粘贴到「完成授权」框（30 分钟内、只能用一次）。
   - 授权链接需 secret `TTS_SERVICE_ID`；没设时也可用 Partner Center 的「复制授权链接」。
2. 查看店铺 ID：`tts-p0-probe {"action":"shops"}`
3. 只读实测（每店一次，handles 填该站点 10 个已知达人账号）：
   ```
   tts-p0-probe {"action":"read","shop_id":"店铺ID","handles":["handle1","handle2","..."]}
   ```
   覆盖：名额、筛选项、handle→open_id 解析成功率、资格检查、外联记录、会话列表、计划列表。**不会发任何东西、不消耗名额。**
4. 写入实测（每店一次，**会真实建计划、消耗 1 个名额、给达人发消息**，达人请选自己人/合作熟人）：
   ```
   tts-p0-probe {"action":"write","shop_id":"店铺ID","handle":"达人账号","product_id":"商品ID","commission_pct":10,"ad_commission_pct":5,"contact":{"email":"店铺联系邮箱"},"message_text":"Hi, we'd like to invite you: {link}","send_card":true,"confirm":"SEND"}
   ```
   覆盖：建计划（1 达人 1 商品）→ 查详情（核对佣金单位）→ 生成邀请链接 → 取/建会话 → 发文字（`{link}` 自动替换为邀请链接）→ 发计划卡片（`send_card:true` 时）→ 读回聊天记录 → 发送前后名额对比。
   之后请在**店铺后台**看这个计划的佣金显示是否为 10% / 广告 5%，在**达人手机端**看消息与卡片的样子，截图发回。
5. token 刷新：`tts-p0-probe {"action":"refresh","shop_id":"店铺ID"}`
6. 补测单个接口（Claude 会给具体指令）：`{"action":"raw","shop_id":"…","method":"POST","path":"/affiliate_seller/…","body":{…}}`

## 4. 实测结果

### 4.1 只读实测（2026-11-10，两店均已完成）

| 项 | PH（8646920450261288950） | TH（8646920450314045430） |
|---|---|---|
| 授权 | ✅ 一次授权带出 PH、TH 两店（CROSS_BORDER），scope 11 个；access 7 天、refresh 到 2125 年 | 同左 |
| 周名额 | ✅ code=0；`unlimited=true`、`gmv_tier=0`、`quota_sum=-1`、无 `quota_details` 分档 | 同左 |
| 筛选项 | ✅ code=0，但 `option_list`/`sorters` 均为空 | 同左 |
| handle 解析（完全相等才算） | 8/10 = 80% | 9/10 = 90% |
| 未解析 | `sshlyp`：搜索无任何结果；`dayanamarieeefinds`：只搜到 `dayanamarieeeefind`（多一个 e、少 s） | `aaalarnz.e`：只搜到 `aaalarnz.en` |
| 资格检查 | ✅ code=0，8 人均 `is_creator_follower_count_threshold_met=true`、`is_creator_level_quota_available=true`，`is_batch_quota_consumable=true` | ✅ 同左，9 人 |
| 外联记录 | ✅ code=0，total=0 | ✅ 同左 |
| 会话列表 | ✅ code=0，返回 BD 手工建立的历史会话（含未读） | ✅ 同左 |
| 计划列表（ONGOING） | ✅ code=0，69 个 | ✅ code=0，32 个 |

### 4.2 实测发现（影响后续实现）

| # | 发现 | 处理 |
|---|---|---|
| T1 | 两店名额 `unlimited=true`（无上限），当前 R3 名额截断不会触发 | R3 逻辑照做（名额以后可能变成有限）；看板显示「本周名额：不限」 |
| T2 | 资格检查返回的字段比文档少：没有 `creator_level`、`is_connected`、`is_paired`、`is_blocked`（**未核验**：是值为 false/0 时被省略，还是不限名额时不计算） | R3「已建联不占名额」暂不依赖这些字段；达人等级改从搜索结果 `creator_profile.creator_level` 取（实测有值 0–5） |
| T3 | 搜达人接口限流明显：19 次搜索中 10 次需要重试（attempts 2–4），≈3 QPS 偏快 | P1 起搜达人单独限速 ≈1 次/秒；handle 解析结果写缓存表 `tts_creators`，同一 handle 不重复搜 |
| T4 | 3 个未解析的 handle 中 2 个是 Excel 账号写法与真实 username 差一两个字符 | 预检结果里把「最接近的候选账号」列给 BD 确认，**不自动替换**（仍按「完全相等才接受」） |
| T5 | 会话列表包含 BD 在后台手工聊的全部会话 | R12 回复通知只针对本系统外联过的达人（按 `im_conversations` 里系统建的会话过滤），不打扰手工会话 |
| T6 | 外联记录在两店都是 0，但店里近期有大量手工定向计划 | 暂不能用外联记录接口核对外联效果，以本系统自己的发送记录为准 |
| T7 | 两店已有大量 BD 手工建的 ONGOING 计划（PH 69、TH 32，很多是 50 人满额） | R7 冲突检查在实际批次里会频繁命中，提交前预检是必要的 |

### 4.3 写入实测

- 2026-11-10 PH 第 1 次：建计划失败 `98001004 invalid name or message`（未创建任何计划、未发消息）。当时 name=`P0-PH-1731250718136961014-20261110-yunge008`（43 字符）、message 约 160 字符英文。文档未写 name/message 的长度或字符限制。
  处理：write 默认名改短为 `P0-{站点}-{YYYYMMDD}-{操作人}`，支持 `tc_name` 自定义；遇 98001004（平台已拒绝、未创建，可安全重试）自动依次重试「去掉 message」「短名 + 去掉 message」，从结果判断是哪个字段不合规。

- 2026-11-11 PH 第 3 次（新版函数已部署）：**全部成功**。计划名改为 `P0-PH-20261111-yunge008`（23 字符）、message 原样保留（约 160 字符）→ 一次通过、未触发重试。**结论：上次失败原因是计划名过长**（43 字符失败、23 字符通过；确切上限未核验，中文字符如何计数未核验）。

| 项 | PH | TH |
|---|---|---|
| 建计划 code=0 / 计划 ID | ✅ `7706908301757384455`，2 达人 × 2 商品，`target_collaboration_conflicts=[]` | 待跑 |
| 佣金单位 | ✅ 详情回读 `rate=2000`、`shop_ads_commission_rate=500`；**后台显示「标准 20%、店铺广告 5.00%」，单位确认 = 万分比**；有效期至 2027/1/10（=创建+60 天）；免费样品「手动审核申请」 | |
| 广告佣金字段生效 | ✅ `shop_ads_commission_rate` 被接受并回读 | |
| 佣金生效时间 | ✅ 新建计划立即生效（`effective_time`=创建时刻，`EFFECTIVE_ALL`）；5 天延迟只针对修改 | |
| 邀请链接 | ✅ `https://affiliate.tiktok.com/api/v1/oec/affiliate/seller/invitation_group/share/long_url/…` | |
| 取/建会话 | ✅ 两人均返回 `is_new=false`（BD 之前手工聊过，复用旧会话） | |
| 发 TEXT / 发计划卡片 | ✅ 各 2 条均 code=0；读回：文字含链接，卡片为 `{"invitation_group_id":"…"}` | |
| 名额消耗 | 不限名额店铺 `quota_use` 前后都是 0，无法验证消耗口径 | |
| 店铺端会话显示 | ✅ 文字原样显示（链接是一长串原始 URL，不美观）；计划卡片显示为「免费样品」卡：计划名、计划 ID、商品图与每件佣金金额 | |
| token 刷新 | ✅ 2026-11-11 refresh 成功，PH/TH 两店一起更新，access 到期顺延到 2026-11-18；scope 11 个 | （同 PH，共用一套 token） |

写入实测新增发现：
- W1 **计划名长度有限制**（43 字符被拒 `98001004 invalid name or message`）。R13 命名 `{站点}-{首个商品SKU或ID}-{YYYYMMDD}-{BD}-{序号}` 若用 19 位商品 ID 会到 38+ 字符，有被拒风险 → 实现时优先用 SKU 简码；超长时截短；上限需再测（见 §5 待补测）。
- W2 已有会话会被复用，且能读到 BD 在后台手工发过的历史消息和达人的历史回复（如 kjrpresent 之前回过 "Yes sir!!!"）→ 可用于判断「已建联（回过消息）」（R3），也能看到手工外联记录（R6 目前只查本系统发送记录，是否扩展到手工记录待定）。
- W3 消息方向判断：店铺发出的消息 `sender_id` 固定（PH 店为 `7311058934513091593`），达人发的 `sender_id` = 会话里的 `creator_im_id` → im-sync 用这个区分 IN/OUT。
- W4 计划卡片读回类型 `TARGET_COLLABORATION_CARD`，内容字段名是 `invitation_group_id`（发送时用 `target_collaboration_id`）。

## 5. 待补测

- TH 写入（负责人：下一轮再发）。
- 文案优化（负责人反馈：不够结构化、不够活泼）：R8 模板库阶段处理；发卡片时文字里可不再放原始链接（卡片已含计划与商品）。
- 计划名长度上限（N1/R13 需要）：用 raw 建计划时逐档试 30 / 40 字符及中文名。
- N1 预研（负责人要求：PH 把其他达人、商品加进 `7706908301757384455`）：已做 `add_to_tc` action。文档核对结论：
  - Update 是**全量覆盖**：响应含 `update_failed.remove_creator_open_ids / remove_product_ids`，漏传 = 移除 → 必须先读详情再合并提交；详情计数与列表数对不上时中止。
  - Update 字段名与 Create 不同：`commission_rate` / `target_ad_commission_rate`；`seller_contact_info.email` 在 Update 里必填；Update 不能改 message。
  - 提高佣金立即生效，降低佣金延迟生效（文档原文截断，延迟天数以「5 天」为准，待核验）。
  - 成功响应也可能部分失败：要检查 `update_failed` 与 `target_collaboration_conflicts`。
