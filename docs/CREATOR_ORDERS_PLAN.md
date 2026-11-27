# 达人出单日报（可行性 + 计划）

> 2026-11-27 claude（1127.329 初版，1127.330 按负责人反馈与探测结果更新）。
> 需求：每天看谁爆了什么品、什么素材；维度 站点 / 达人 / 素材 VID / SKU（无 SKU 时到商品）；带归属同事；标官号、营销号（= 渠道号）。给同事看。
> 原型（示例数据，v3）：https://claude.ai/artifact/2S2VzWK3tjfNRTHApqtg22
> 负责人 2026-11-27：页面放「GMV 归因」组，主要看达人、素材表现；本次不一定继续从联盟订单接口往下做（探测结果先记录）。

## 1. 订单来源（1127.330 更正）

**变更说明**：1127.329 版把订单分成「达人 / TAP / 非合作」三类，并用「视频 GMV − 联盟订单」的差额算非合作订单。负责人反馈后台大部分店铺已没有「非合作」选项，VN 实测（下文）也显示视频 GMV 基本都能在联盟订单里找到 → 去掉「非合作」一类，改为下面三类：

| 来源 | 接口 | 粒度 | 互斥依据 |
|---|---|---|---|
| 达人联盟 | 联盟订单 `POST /affiliate_seller/202410/orders/search`，`campaign_id` 为空的行 | 订单 × SKU，实时 | 同一 SKU 行只会是其中一类 |
| TAP 机构 | 同一接口，`campaign_id` 非空的行 | 同上 | ✅ 实测：TAP 行 `creator_username` 为空、`content_id`（VID）有值 |
| 官号 | 视频分析 `GET /analytics/202605/shop_videos/performance`，`creator.author_type = OFFICIAL_ACCOUNTS` 或账号名含 artphro | VID × 商品，次日 | 官号不走联盟，联盟订单里没有 |

账号类型（与来源是两回事）：达人 / 营销号（`MARKETING_ACCOUNTS`，负责人定 = 渠道号）/ 官号。

## 2. 探测结果（VN，2026-11-26 整日，负责人在「API测试」页跑，2026-11-27）

**联盟订单**（`total_count` 62 个 SKU 行，单页返回完）
- 字段齐：`creator_username`、`content_type`（实测出现 VIDEO / SHOP / LINKSHARE）、`content_id`、`product_id`、`sku_id`、`sku_name`、`seller_sku`（如 AR333-B-K）、`price`、`quantity`、`create_time`、`settlement_status`（含 INELIGIBLE）、`target_collaboration_id` / `open_collaboration_id`（定向 / 公开计划）。
- TAP 行只看到 1 行（`campaign_id` 7612912158965286663、`partner_commission_rate` 2000、达人名为空、VID 有值）。⚠️ 负责人说「大部分是 TAP 机构出单」，VN 当天样本不符，其他站点未测。

**视频列表 202605**（`account_type=ALL`、单日、按 gmv 倒序）
- ✅ 单日可查；`latest_available_date` = 2026-11-26（次日可用）。
- `total_count` 2907：**含当天 0 成交的视频**，有成交的约前 30 条 → 翻页到 gmv=0 即停。
- `author_type` 实测值：`AFFILIATE_ACCOUNTS`、`OFFICIAL_ACCOUNTS`（artphro_vn）。⚠️ 其他站点官号（artphro_ph、artphro_thh）在 VN 店显示为 `AFFILIATE_ACCOUNTS` → 官号识别要加「账号名含 artphro」规则（负责人：官号一般以 ARTPHRO 命名）。
- `attributed_gmv` = `gmv` + `indirect_gmv`。

**视频 GMV vs 联盟订单（同 VID，人工从贴回结果摘录 8 个 VID，Python 计算）**
- 5 个完全相等（联盟订单 price×quantity 合计 = 视频 `attributed_gmv`），3 个差 −1,000 / −1,000 / +10,000 VND。⚠️ 差异原因未查（可能是摘录误差或跨日边界），口径以联盟订单为准。

**单视频按商品拆分**：未跑成（命令里的 `<视频id>` 占位没替换），不影响当前方案。

## 3. 用 GMV Max 数据做是否更简单（负责人 2026-11-27 问）

| 要的列 | GMV Max 报表（按素材） | 联盟订单 | 视频分析 |
|---|---|---|---|
| 花费、ROI | ✅ 唯一来源 | — | — |
| 订单、GMV | 只有广告带来的那部分 | ✅ 全部联盟出单（含自然流量） | 有，次日 |
| 达人 handle | ❌ 接口已不返回（阶段 A 已确认） | ✅（TAP 行为空，用 VID 补） | ✅ |
| SKU | ❌ 只到商品 | ✅ | ❌ |
| 播放 | 有（广告播放） | — | ✅（全部播放） |

结论：只用 GMV Max 拿不到达人和 SKU，也漏掉非广告出单，不会更简单。建议三者拼：订单 / GMV / SKU / 达人用联盟订单，花费 / ROI 用 GMV Max（按 VID），播放 / 官号用视频分析。
⚠️ GMV Max 每日落库自 10-12 暂停（ROADMAP §2 P0 待决策）。本页只需当天按 VID 汇总的花费，可以实时查或只存极小的日汇总，不依赖 §2 恢复 VID 级落库。

## 3.1 GMV Max 能否拿到达人名、SKU（负责人 2026-11-27 要求再确认，1127.331）

负责人更正：GMV Max 报表的订单是全局的，含自然流量订单（上一版 §3 表里「只有广告带来的那部分」**说错了，以负责人为准**）。

- **SKU：拿不到（文档确认）**。`/gmv_max/report/get/` 的维度只有 `advertiser_id / campaign_id / stat_time_day / stat_time_hour / item_group_id（商品 SPU）/ item_id（素材）/ room_id / duration`，没有 SKU 维度（来源：Go SDK `bububa/tiktok-business` 对官方文档的镜像；官方页是前端渲染，抓不到正文）。
- **达人名：能取，原因已查明（官方文档，负责人 2026-11-27 贴原文）**。`tt_account_name`（账号名）、`tt_account_authorization_type`（TTS_TT 官号 / AFFILIATE 联盟 / TT_USER / BC_AUTH_TT / AUTH_CODE）、`shop_content_type`（VIDEO / PRODUCT_CARD）、`title` 属于「属性指标」，只有在 **过滤单个 campaign_id + 单个 item_group_id、维度里只有一个 ID 维度**（如 `["item_id","stat_time_day"]`）时才返回；多 ID 维度或一次过滤多个商品就拿不到。2026-11-25 抓取用了 `[campaign_id,item_group_id,item_id]` + 一次 100 个商品，所以被判无效（**上轮结论「接口已不返回」是错的，是请求写法问题**）。⚠️ 文档注明：token 对该 TikTok 账号无权限时账号名返回 0 或 -1，联盟达人覆盖率需实测。代价：每个「系列 × 商品」单独请求一次。1127.331 探测已按文档写法改（4 种写法对比 + 逐字段），🔧 负责人点 ⏱ 后 Claude 读结果。
- **探测结果（1127.333，负责人 2026-11-27 跑 VN、PH，近 7 天，各取花费最高的 1 个系列 × 1 个商品）**：
  - 写法：`[item_id, stat_time_day]`、`[item_id]`、`[item_id]+ADS_AND_ORGANIC` 三种都能取属性指标；`[campaign_id,item_group_id,item_id]` 全部判无效 → 与文档一致。`identity_id`、`product_name` 素材级不支持。
  - ✅ 能用：`tt_account_authorization_type`（实测 TTS_TT 官号、AFFILIATE 联盟）、`shop_content_type`（VIDEO / PRODUCT_CARD，商品卡 item_id=-1）、`title`（视频文案）。
  - ❌ `tt_account_name` 实测全部为 "0"（存库样本 VN、PH 各 2 个视频，含 TTS_TT 官号与 AFFILIATE 联盟各类；头像同为 0）。按文档 = 我们的 token 对这些 TikTok 账号没有权限。⚠️ 样本只存了每个字段前 3 行，未逐行统计全部 20 行；连官号也是 0，说明不是「联盟达人才没有」。
  - 结论：**GMV Max 报表拿不到达人名，也拿不到 SKU**。达人名按 VID 关联：联盟订单 `creator_username`（实时，TAP 行为空）→ 视频分析 `username`（次日，9 站覆盖 100%）。官号/联盟可直接用 `tt_account_authorization_type` 区分。⚠️ 让账号名有值可能需要把账号授权进 BC（未核验，不建议为此改授权）。
- **负责人 2026-11-27 定：SKU 维度用 SPU 足够**。主 SKU = 飞书商品表（`sku_product_map`，「SKU匹配表-TK」每晚同步）里该 SPU（product_id）出现的**第一行**的商家 SKU。⚠️ 现表无行号（id 为 uuid、created_at 全相同），开工时同步要加 `row_no` 才能取「第一行」。
- **达人名来源比较（1127.335）**：
  - TikTok Shop `/analytics/202605/shop_videos/performance`：✅ 已实测（VN 11-26），返回 `creator.user_name / nick_name / open_id / author_type`（实测值 AFFILIATE_ACCOUNTS / OFFICIAL_ACCOUNTS，不是第三方资料写的 AFFILIATE / CHANNEL）；`/analytics/202609/shop_videos/batch_performance`：✅ 9 站覆盖 100%，按 VID 批量（只有 username，无昵称）。→ **主方案**。
  - Business `/gmv_max/identity/get/`：返回 `display_name / user_name`，但只列出店铺/BC 可用的广告发布身份（TTS_TT 官号/营销号、BC_AUTH_TT、TT_USER、AUTH_CODE）；**枚举里没有联盟达人（报表授权类型 AFFILIATE）**，且不含 VID，不能单独做 VID→达人。现有代码已在用（建组页视频账号面板，`listIdentities`）。
  - Business `/gmv_max/video/get/`、`custom_anchor_video_list/get/`：按 identity 返回 `item_id + identity_info.display_name`。11-25 探测返回空——文档写明「未传 identity_list 且 need_auth_code_video≠true 时返回空列表」，**是请求写法问题**；但同样只覆盖上述身份，不含联盟达人。可用于给官号/营销号素材补名，价值低（Shop 接口已覆盖）。
- **GMV Max 订单含自然流量**：文档写明 orders / gross_revenue 为 "paid and organic"（与负责人一致）。
- **兜底（都已实测可用，不依赖上面的探测）**：
  - 达人名：按 VID 关联联盟订单的 `creator_username`（实时；TAP 行为空）或视频分析 `username`（次日；batch_performance 9 站覆盖 100%）。
  - SKU：按 VID 关联联盟订单（`content_id` = VID，带 `sku_id / seller_sku / quantity / price`），把该 VID 在 GMV Max 的订单/GMV 按联盟订单的 SKU 占比拆分。⚠️ 官号素材不走联盟，只能到商品级。

ROI 口径（负责人 2026-11-27 定）：**ROI = GMV ÷ 花费**，GMV、花费都取 GMV Max 报表（按素材）。

## 4. 页面（原型 v3）

- 页内 TAB：数据 / 设置 / 说明（说明默认不展开）。
- 维度：达人 / 素材 / SKU。所有维度同一组 10 列，主行与展开行对齐：达人 | 素材 VID | SKU | 归属 | 播放 | 订单 | GMV | 花费 | ROI | 近 7 日。
  - 达人维度：展开为该达人的素材，SKU 列显示该素材出单最多的 SKU。
  - 素材维度：展开为该素材的 SKU。
  - SKU 维度：按商品聚合，显示**主 SKU**（商品的第一个 SKU）+ 商品名，PID 小字；展开为各 SKU，主 SKU 标「主」。
- 爆单（负责人 2026-11-27 定）：单素材当天订单 ≥ 10，或单达人当天订单 ≥ 20；两个门槛在「设置」可调。
- ROI = GMV ÷ 花费（负责人定，均取 GMV Max 报表）。
- 归属：VID 登记人优先，其次达人归属 BD，官号显示「官号」，都没有显示「未归属」。

## 5. 归属覆盖面（VN 2026-08，接口返回的 2,968 个有消耗 VID，按 GMV Max 花费算）

达人 handle 命中 69.0%，VID 登记命中 26.0%，任一命中 70.4%。

## 6. 存储与更新（待开工时定）

- 联盟订单：每小时拉当天 + 昨天，按 站点 × 日 × VID × SKU × 来源 汇总存，不存订单原文。
- GMV Max 花费：按 站点 × 日 × VID 汇总。
- 视频分析：每天一次，只存有成交或有花费的 VID。
- 保留天数 🙋（建议 90 天）。

## 7. 待负责人决定

- 🙋 是否开工、先做哪几个站点。
- 🙋 保留天数。

## 8. 昵称匹配与多来源风险（1127.336）

**达人名**：Shop 202605 视频列表同时给用户名（handle）和昵称；batch_performance 只给用户名。
- 昵称核对：探测样本里 3 个 VID 同时有导出表昵称与接口昵称，3 个逐字一致（`Nam thích mặc đẹp` ×2、`artphro_VN`）。⚠️ 样本小。
- 和已有数据匹配：归属库 `creator_ownership` 同时有 HANDLE（VN 2,210）与 NICKNAME（VN 1,364）两种键；登记表 VN 6,739 行中 4,405 行有 handle、4,716 行有昵称 → 先按 handle，再按昵称兜底。负责人 11-25 已定「达人 = 接口 handle」，handle 命中率 ≥ 导出昵称（VN 6/8 月 72.9%/75.7% vs 65.1%/73.4%）。
- 昵称会改、会重复；handle 唯一但也可能改，均按 VID 当时的值记录。

**多来源风险**
| 风险 | 程度 | 处理 |
|---|---|---|
| GMV Max 报表金额准确性 | 低：VN 6–8、JP 8 逐 VID 与导出表一致 | 每月抽一个站对账 |
| 无授权连接的广告户（如 ADFLY2）取不到 | 中：该户花费缺失 | 换户提醒；设置页显示「无连接」 |
| VID → 达人名 覆盖 | 低：batch_performance 9 站 × 6–8 月覆盖 100%（按有花费 VID） | 未命中标「未识别」 |
| 昵称只在列表接口 | 中：列表单次 ≤30 天、含大量 0 成交视频，需翻页 | 每天增量拉、按 VID 缓存；昵称缺失时只显示用户名 |
| 日期口径 | 中：GMV Max 按广告户时区，Shop 按店铺时区（如 VN 户 +8、店 +7） | 统一按广告户时区；达人名与日期无关不受影响 |
| 调用量 / 限速 | ⚠️ 未核验 | 每店串行 + ttGet 退避；先 VN、PH 跑 7 天看耗时 |
| 主 SKU | 中：飞书表无行号 | 同步加 row_no；商品不在表里显示 PID |
| 归属覆盖 | VN 8 月按花费约 70% | 未归属单独显示，可筛 |

## 9. 日期口径与容量（1127.337）

**新加坡时间（负责人提议）**：GMV Max 报表日期按**广告户时区**，接口无时区参数。素材级维度只支持 `stat_time_day`，**不支持小时**（文档：素材级组合仅 `[campaign_id,item_group_id,item_id](+stat_time_day)`、`[item_id,stat_time_day]`）；商品级、系列级支持 `stat_time_hour`。
→ 汇总、走势图、SKU（商品级）可按小时取数后折算成新加坡日；**达人 / 素材行只能按广告户日**。广告户时区为 UTC+8 的与新加坡日完全一致；非 UTC+8 的（实测 MX 户 America/Mexico_City UTC-6，相差 14 小时）两层会对不上。各户时区未入库（⚠️ 未核验，可由 `/advertiser/info/` 取）。🙋 见对话选项。

**容量估算（⚠️ 估算，未实测）**：2026-10 各站上传导出表合计 212,721 行/月（素材 × 商品，含 0 值行）。按日落库只存「花费 > 0 或订单 > 0」的 素材 × 商品 × 天，量级按每月 20–25 万行估，每行约 250 字节（含索引）→ 约 50–60MB/月；保留 90 天 ≈ 150–200MB（当前库 2.25GB / 上限 7.6GB）。
优化：①只存非零行；②达人名、昵称、标题等文本放单独 VID 维表（每 VID 一行），日表只存数字；③90 天后按 达人 × 月、商品 × 月 汇总后删日表。

**接口载荷**：金额不再取属性字段 → 可一次过滤最多 100 个系列 / 100 个商品，每户每天约「系列数 ÷ 100 × 商品批次」次；每小时只刷今天 + 昨天。Shop 达人名只对新出现的 VID 调 batch_performance（每次 ≤500 个），昵称每天一次增量。⚠️ 限速未核验，先 VN、PH 跑 7 天看耗时。

## 10. 实施（1127.338，负责人 2026-11-27「可以实施」）

- 负责人定：保留不设上限，库容到 80% 再考虑删旧数据；数据库要优化（已按 §9：非 0 行、bigint ID、整数分、文本拆 VID 维表）。
- 取数频率（**变更**，1127.351 负责人定，新加坡时间）：只查当天启用的广告户；今天每小时、昨天 0/6/12/18 点、前天 6/18 点那一轮（原：所有户每小时取今天 + 前两天）。原因：花费数据最长延迟 11 小时（官方文档），换日只取一次会漏晚到的数据；每户每次约 3–10 次调用，量很小。
- 日期：按广告户时区（素材级只能按天）。**变更**：主 SKU 取「出现最多的基础货号」，不是「第一行」——现表无行号；同一商品下基础货号几乎都相同（如 AR3122 系列 12 行全是 AR3122），只有组合装第一段不同时才有区别。
- 显示：SKU 只保留 AR/NE + 3–4 位数字，下行 PID（无前缀），列名「SKU/PID」，列宽加宽；› 按钮加大到 28px。
- ⚠️ 未实测：上线后第一次整点刷新的耗时、各户是否都有授权连接（ADFLY2 无）、Shop 接口限速。

## 11. 首次刷新与分步（1127.342）

- 11-27 19:04（北京）负责人点「立即刷新」：只写入 2 个广告户（ECO9B-SG 0 行、ECO9B-MY 328 行：11-26 花费 66.84 / GMV 171.28 / 订单 17），约 20 秒后中断，达人名未补。判断 Lovable 服务端单次请求时长有限（⚠️ 具体上限未核验）。
- 改为分步：页面「立即刷新」每步 ≤20 秒自动续跑并显示进度；定时任务改为每 5 分钟一步（≤25 秒），游标记库，每个整点开一轮（migration `20261127230000_creator_orders_stepwise.sql`，取代 `creator-orders-hourly`）。
- 表格分页：每页行数 = 屏幕高度能放下的行数（表头贴顶、拉到底刚好看到本页最后一行与页脚），翻页时表头滚到屏幕顶部。
- 1127.345：ECO9B-PH 报 TikTok「Internal service timed out」（一次查 100 系列 × 100 商品太重）→ 商品 20 个一批、超时自动对半拆开重试；同步最小步改为「广告户 × 天」；定时任务同一步连续 2 次没跑完就跳过并在同步状态里记错误（`co_settings.sync_tries`，并入 migration 20261127230000，负责人尚未执行，故直接改该文件）。
