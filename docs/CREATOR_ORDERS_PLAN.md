# 达人出单日报（可行性 + 计划）

> 2026-11-27 claude，1127.329。负责人需求：每日知道谁今天爆了什么品、什么素材；维度 站点 / 达人 / VID / SKU（无 SKU 时 PID）；带达人、VID 归属同事；标自有官号、渠道号。给同事看。
> 原型（示例数据）：https://claude.ai/artifact/2S2VzWK3tjfNRTHApqtg22

## 1. 订单来源：三类互斥（负责人 2026-11-27）

Seller Center 前端导出把订单分成三类，逻辑上互斥：**达人出单**、**TAP 机构出单**、**非合作订单**。每类要单独找接口。

| 来源 | 接口 | 依据 | 拿得到 | 拿不到 / 待测 |
|---|---|---|---|---|
| 达人出单 | `POST /affiliate_seller/202410/orders/search` | 官方文档（2026-11-27 重读）+ `tts-export` 月度联盟订单已在用 | 订单 × SKU：`creator_username`、`content_type`（SHOP/VIDEO/LIVE/PRE_LIVE/PROMOTION_PAGE/LINKSHARE）、`content_id`（VID）、`product_id`、`sku_id`、`sku_name`、`seller_sku`、`price`、`quantity`、`create_time`、佣金、`fully_return`；按下单时间筛，单次 ≤3 个月，实时 | — |
| TAP 机构出单 | 同上，`campaign_id` 非空的 SKU 行 | 官方文档 | 同上 SKU 级，带 TAP 活动 ID、机构佣金率 | ⚠️ 文档写明 TAP 单 `creator_username` **返回空**；`content_id` 是否还有值未写 → 探测 P1。没有达人名时按 VID 用视频接口补 handle。机构名称接口不给（`tts-export` 已记录） |
| 非合作订单 | 联盟订单接口**不含**（文档：只返回 "affiliate-commission eligible" 订单，⚠️ 待 P1 实测确认）。只能用视频分析接口：`GET /analytics/202605/shop_videos/performance`（视频 × 日，全部账号）+ `GET /analytics/202509/shop_videos/{vid}/products/performance`（视频 × 商品） | 202409 版 VN 2026-11-25 实测返回 VID / username / products / gmv / units_sold；202605 版文档 | VID、达人 handle、PID、GMV、件数、播放、发布时间 | **无 SKU**（只到 PID）；T+1（`latest_available_date` = 昨天）；202605 版单次 ≤30 天（实测报错）。非合作 = 视频 GMV − 同 VID×PID 的联盟订单 GMV（差额法，⚠️ 口径待对账） |

订单接口 `/order/202309/orders/search` 不带达人 / 内容字段（`tts-export` 已记录 Creator Handle 接口不提供），不能用来分来源。

**上轮遗漏**：`tts-export` 的「月度联盟订单」只拆了达人 / 服务商两张表，没有非合作订单；与前端导出的三类不对应。

## 2. 账号类型：官号 / 渠道号

- `202605` 视频列表有 `account_type` 筛选（ALL / OFFICIAL_ACCOUNTS / MARKETING_ACCOUNTS / AFFILIATE_ACCOUNTS），返回 `creator.author_type`（示例值 OFFICIAL）→ 官号、营销号可以直接从接口拿。⚠️ 未实测。
- 🙋 「渠道号」是否等于 TikTok 的营销号（MARKETING_ACCOUNTS）？不等于的话，用飞书表补：列 = 站点 / handle / 类型（官号、渠道号）/ 负责人 / 备注；接口给的类型优先，飞书表补接口不认的。

## 3. 归属同事（复用归因数据，不新建规则）

- VID 归属：`staff_vid_map`（剪辑表 / BD 表登记的 VID，每晚 23:00 同步）。
- 达人归属：`creator_ownership`（key_type=HANDLE，`owner_bd`）。
- 顺序：VID 有登记 → 登记人；否则达人归属 BD；官号 → 「官号」；都没有 → 未归属。⚠️ 这和归因引擎（Pass 1/2、发布时间窗口）不是同一套口径，只是「看是谁的」，不是业绩归因。
- 覆盖面实测（VN 2026-08，接口返回的 2,968 个有消耗 VID）：按 GMV Max 花费算，达人 handle 命中 69.0%，VID 登记命中 26.0%，任一命中 70.4%。

## 4. 每日更新与存储

| 任务 | 频率 | 量级（估） | 落库 |
|---|---|---|---|
| 联盟订单（达人 + TAP） | 每小时，拉当天 + 昨天（补状态） | 10 店 × 每天数千 SKU 行 | 按 站点 × 日 × VID × SKU × 来源 汇总，不存订单原文 |
| 视频列表（含非合作、账号类型） | 每天 1 次（T+1） | VN 近 4 个月 15,949 个视频；单日只取 GMV>0 的，按 gmv 倒序翻页到 0 为止 | 站点 × 日 × VID 一行 |
| 视频 × 商品 | 每天，只对有 GMV 的 VID | 每 VID 1 次调用 | 站点 × 日 × VID × PID |

- 数据库容量（3.88GB / 7.6GB，G9 治理中）：只存汇总，保留 🙋 N 天（建议 90）。
- TikTok Shop 调用走 `_shared/tts.ts`（`tts-export` 同一套签名与退避）；限速未核验，按每店串行。

## 5. 待实测（负责人在「API测试」页粘贴，结果贴回给 Claude）

VN 店，北京时间 2026-11-26 整日（VN 当地 00:00 = 1795626000）：

```
tts-p0-probe {"action":"raw","shop_id":"8646920450130020342","method":"POST","path":"/affiliate_seller/202410/orders/search","query":{"page_size":"100"},"body":{"create_time_ge":1795626000,"create_time_lt":1795712400}}
```
看：有无 `campaign_id` 行、这些行的 `content_id` / `creator_username`、`total_count`。

```
tts-p0-probe {"action":"raw","shop_id":"8646920450130020342","method":"GET","path":"/analytics/202605/shop_videos/performance","query":{"start_date_ge":"2026-11-26","end_date_lt":"2026-11-27","page_size":"100","sort_field":"gmv","sort_order":"DESC","currency":"LOCAL","account_type":"ALL"}}
```
看：单日能否查、`creator.author_type` 取值、官号视频是否在内、`total_count`。把 `account_type` 换成 `MARKETING_ACCOUNTS`、`OFFICIAL_ACCOUNTS` 各跑一次。

```
tts-p0-probe {"action":"raw","shop_id":"8646920450130020342","method":"GET","path":"/analytics/202509/shop_videos/<上一条第一个视频 id>/products/performance","query":{"start_date_ge":"2026-11-26","end_date_lt":"2026-11-27","page_size":"20","currency":"LOCAL"}}
```
看：单视频按 PID 拆的 GMV / 件数。

对账：同一天 Seller Center 联盟订单三类导出的 GMV 合计，与 P1（达人 + TAP）及「视频 GMV − 联盟订单」差额对比。

## 6. 阶段

1. 探测（上面 3 条）+ 负责人确认 §7 待定项 → 改原型。
2. 后端：每小时联盟订单汇总 + 每日视频汇总 + 归属拼接；先 VN / PH 两店跑 7 天，与前端导出三类逐日对账。
3. 前端页面（左侧「达人建联」或「店铺」组下新 tab，🙋 放哪组）。
4. 可选：每晚飞书推「今日爆」。

## 7. 需负责人决策

- 🙋 「爆」的口径：原型用「当日 GMV ≥ 近 7 日日均 × 3 且 ≥ 50 USD，或首次出单 ≥ 50 USD」。
- 🙋 渠道号 = TikTok 营销号？不等于就建飞书「账号类型」表。
- 🙋 官号视频产生的订单，在前端导出里算哪一类（非合作？还是不在三类里）。
- 🙋 汇总保留天数（建议 90 天）。
- 🙋 页面放在哪个导航组。
