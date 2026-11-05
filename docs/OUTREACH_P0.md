# 联盟达人外联 · P0 实测记录

> 交接文档：`docs/OUTREACH_HANDOFF.md`（§4.3 接口表已按本次核对结果更新）。
> 状态：**文档核对已完成；两店实测待负责人完成授权后执行**（§3 步骤，结果填 §4）。

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

1. 授权入库：浏览器登录 PH/TH 卖家账号 → 打开 Partner Center 的「复制授权链接」→ 同意 → 跳转后地址栏 `code=` 后面那串（30 分钟内有效、只能用一次）：
   ```
   tts-p0-probe {"action":"exchange","auth_code":"粘贴code"}
   ```
   返回 `saved` 里应看到 PH、TH 两个店铺（跨境卖家一次授权可带出多个站点店铺）。
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

## 4. 实测结果（待填）

| 项 | PH | TH |
|---|---|---|
| 授权 / granted_scopes | | |
| 名额（gmv_tier / 分档 / 已用 / 剩余） | | |
| 10 个 handle 解析成功率 | | |
| 资格检查 code=0 | | |
| 建计划 code=0 / 计划 ID | | |
| 佣金单位与后台显示一致 | | |
| 广告佣金字段生效 | | |
| 邀请链接 | | |
| 取/建会话 | | |
| 发 TEXT / 发计划卡片 | | |
| 1 次外联消耗名额数 | | |
| token 刷新 | | |
