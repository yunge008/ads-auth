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
