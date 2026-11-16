# TikTok Shop Open API 调研：评价 / 联盟数据 / 订单 / 财务 / 商品

> 2026-11-16 claude。来源：Partner Center 官方文档数据接口（`partner.tiktokshop.com/api/v1/document/tree` 全量 1034 篇、其中 API 395 个；单接口 `document/api_meta?src_document_id=<path>` 取路径 / 方法 / scope / 参数 / 返回字段）。
> 本文只记录**文档事实**；标「待实测」的项必须用 §7 指令跑一次才算核验。

## 0. 结论速览

| 需求 | 能否用 API 直接拿 | 接口 | scope（Partner Center 权限包名） |
|---|---|---|---|
| 商品**评价列表**（文字 / 买家图片 / 单条星级） | **不能**：395 个 API 全量核对，没有任何读评价内容的接口 | — | — |
| 商品**星级分布**（1–5 星各多少条、占比） | 能（按日期区间） | Get Shop Product Performance Detail `GET /analytics/202509/shop_products/{product_id}/performance` → `ratings[]{stars,count,percentage}` | TikTok Shop Analytics |
| 差评订单级星级 | 仅 **US 店**（我们 PH/TH 不可用） | Get SPS Metric Problem Details `metric_code=NRR` → `user_review_rating`；Top Items → `top_review_reasons` | TikTok Shop Analytics |
| 品类热销榜商品星级 | 能（含他店商品，最多 100 个） | Get Bestselling Products `GET /analytics/202511/products/bestselling` → `rating`、`product_image` | Bestsellers |
| 商品图片细节 | 能（自己店铺商品） | Get Product → `main_images[]`、SKU `sales_attributes[].sku_img`、`size_chart.image`、`description`（HTML，内嵌详情图） | Product Basic |
| 达人广场列表（粉丝、销量、GMV） | 能 | Search Creators in Creator Marketplace / Get Marketplace Creator Performance | Read Creator Marketplace |
| 申样达人列表 | 能 | Search Sample Applications + Fulfillments | Read Seller Affiliate Collaboration |
| 合作达人列表 | **没有单独的「合作达人」列表接口**，要拼（见 §2.3） | — | Read Seller Affiliate Collaboration |
| 定向计划列表 / 详情（商品、达人、佣金） | 能 | Search Target Collaborations / Query Target Collaboration Detail / Query Creator Promotion Details | Read Seller Affiliate Collaboration（后者另需 Manage） |
| 订单导出 | 能（分页拉，无「导出文件」接口） | Get Order List / Get Order Detail | Order Information |
| 财务（按订单） | 能 | Get Transactions by Order / by Statement / Unsettled | Finance Information |
| 商品信息导出 | 能（分页拉） | Search Products + Get Product | Product Basic |
| 促销活动详情 / 活动价（实际对客价） | 能，按活动 ID 或完整名称（§8） | Search Promotion Activities + Get Activity | Promotion Information |

**需要新增的权限包**：店铺当前授权 scope 是 11 个，具体是哪 11 个**未核验**（先跑 §7 第 1 条看）。外联 P0 已勾的是联盟相关 5 个；本次新增需求还需要：`Product Basic`、`TikTok Shop Analytics`、`Order Information`、`Finance Information`、`Promotion Information`、`Bestsellers`（只看热销榜才要）。在 Partner Center → 应用 → 权限/API scope 里勾上后，**店铺必须重新授权一次**，新 scope 才会出现在 token 里。

## 1. 评价 / 星级 / 图片

- **没有评价内容接口**：目录里名字带 review 的只有 App 审核、售后审核（Review Aftersales Requests）、样品审核（Review a Sample Application）、联盟活动商品审核，都不是商品评价。changelog「External Product Attribution for Reviews and Ads」只是让 Connector App 回填 `external_product_id`，便于外部平台做评价同步，不是读评价。
- 评价文字 / 买家晒图只能走：店铺后台导出、第三方抓取（非官方，有封号/违约风险）、或 TikTok Research API（研究用途、仅 EU 商品，无图片字段，不适用）。
- **星级分布**：Get Shop Product Performance Detail
  - 入参：`start_date_ge`、`end_date_lt`（店铺时区，`YYYY-MM-DD`，后者不含）、`granularity`（`ALL` 汇总 / `1D` 按天）、`currency`（`USD` / `LOCAL`，默认 LOCAL）。
  - 返回：`ratings[]`（`stars` = `1_STAR`…`5_STAR`，`count`，`percentage` 0–1 小数），口径「所选日期区间内的评价」；同一接口还给 GMV、订单、件数、流量、退款、`top_creators`（达人 open_id / 名称 / GMV / 件数）、`latest_available_date`。
  - 待实测：PH/TH 跨境店能否调通、`ratings` 是否有值。
- Get Shop Product Performance List（`/analytics/202605/shop_products/performance`）**不含** ratings，可按 `gmv` / `items_sold` / `orders` 排序。
- SPS（店铺体验分）系列接口文档写明 **Available only for US-region shops**。

## 2. 联盟

### 2.1 达人广场 Search Creators in Creator Marketplace
`POST /affiliate_seller/202608/marketplace_creators/search`（scope：Read Creator Marketplace）

- **时间维度**：文档写「All the data returned is for the last 30 days」（近 30 天）。
- **货币**：每个金额对象自带 `currency`；文档没写是本币还是 USD，官方样例（GB 达人）返回 `USD`。**待实测**（PH/TH 返回 PHP/THB 还是 USD）。
- 返回字段：`username`、`nickname`、`avatar.url`、`creator_open_id`、`follower_count`、`gmv` / `live_gmv` / `video_gmv`（达人未授权精确数据时不返回）、`gmv_range` / `units_sold_range`（**仅 US**）、`avg_ec_live_uv`、`avg_ec_video_view_count`、`category_ids`、`top_follower_demographics`（前 3 年龄段、主性别占比）、`creator_profile`（`creator_level`、`pps_score`、`has_collaborated`、`has_invited_90d`、`is_fast_growing`、`is_rising_star`、`creator_bind_mcn_name` 等，空对象 = 该地区/账号不支持）。
- **注意**：搜索结果**没有精确 `units_sold`**（只有 US 的区间）。精确销量在下面的详情接口里。
- 筛选：`keyword`（用户名/昵称）、粉丝数区间、粉丝年龄/性别、`gmv_ranges`、`units_sold_ranges`（档位枚举）、类目、内容表现（均播、互动率、直播均观看）、平均佣金档、履约率档、MCN/独立、快速成长、90 天未邀约、高级筛选（按国家不同）。
- **排序**：只能用 `advanced_filters.sorter_algorithm_id`，可选值要先调 Get Creator Marketplace Advanced Search Filters（`{"options":[{"option_type":"OPTION_SORTER"}]}`）拿 `sorters[]{algorithm_id,name}`，按国家不同，默认 1。**不能任意按 GMV/粉丝字段排序**。
- 分页：`page_size` 只能 12 或 20；翻页同时传 `page_token` 和 `search_key`。

### 2.2 达人详情 Get Marketplace Creator Performance
`GET /affiliate_seller/202608/marketplace_creators/{creator_user_id}`（open_id；scope 同上）

- 比搜索多：`units_sold`（精确，需达人授权）、`gpm` / `live_gpm` / `video_gpm`、`avg_commission_rate`（万分比）、`brand_collaboration_count`、`category_gmv_distribution`、`content_gmv_distribution`、`follower_location/age/gender`、`ec_live_count` / `ec_video_count`（近 30 天）、`promoted_product_num`（近 30 天）、`rating`（合作卖家给达人的评分）、`post_rate`、`creator_profile.creator_trend_profile[]`（按时间段的 GMV / 件数 / 粉丝 / 互动率趋势）、`sample_score`、`creator_fulfillment_score_90d`。
- 时间维度**按字段不同**：多数标注「last 30 days」；`units_sold_range` 写的是账号生命周期；`gmv` / `units_sold` 文档**没写**窗口，待实测对照后台。

### 2.3 申样达人 / 合作达人
- **Search Sample Applications** `POST /affiliate_seller/202508/sample_applications/search`：按商品、达人 open_id、用户名、定向计划 ID、订单号、状态筛选；`page_size` ≤50，返回 `total_count`。每条有：申请 ID、`commission_rate`（**小数，0.20 = 20%**，与定向计划的万分比不同）、状态、样品订单号、审批/发货截止时间、运单号、`fulfillment_status`、代理机构名；达人 `username` / `nickname` / `follower_count` / `gmv`（近 30 天）/ `content_count`（近 30 天）/ `fulfillment_percentage`（近 90 天）/ `ec_video_view`；商品 ID / 标题 / SKU / SKU 图。**无排序参数**。注意 body 字段名官方拼写就是 `creator_user_oepn_id`、`target_collabration_id`。
- **Search Sample Application Fulfillments**：单个申请的履约内容（视频/直播 ID、链接、播放、点赞、评论、`paid_order_count`）。
- **合作达人**：没有直接接口。可拼的来源：
  1. 定向计划详情里的 `creators[]`（每个计划的被邀达人 + 上架/发内容商品数）；
  2. Get Open Collaboration Creator Content Details（按商品查公开计划下推广的达人，含粉丝、视频/直播数、推广状态）；
  3. Search Seller Affiliate Orders 的 `creator_username`（真正出单的达人）；
  4. Compass 离线导出 `module_type=CREATOR`（达人列表数据，近 24h / 7 天 / 30 天，文件格式与列**待实测**）；
  5. 达人广场搜索结果里的 `creator_profile.has_collaborated` 标记。

### 2.4 定向计划
- **Search Target Collaborations** `POST /affiliate_seller/202508/target_collaborations/search`：必填 `collaboration_status`（ONGOING / EXPIRING / …）；可按计划名/ID、商品名/ID、达人 open_id、是否送样、达人是否接受筛；`page_size` 20/50/100；返回计划 ID、名称、留言、起止/创建/更新时间、邀请达人数、上架达人数、发内容达人数、商品数、送样规则。**列表不含商品/达人明细**，**无排序参数**。
- **Query Target Collaboration Detail** `GET /affiliate_seller/202508/target_collaborations/{id}`：`products[]`（ID、主图、标题、原价区间、`commission.rate` 万分比、预估佣金金额区间、`shop_ads_commission_rate`、生效时间、状态）、`creators[]`（用户名、昵称、头像、open_id、上架商品数、发内容商品数、状态）、卖家联系方式、计划类型。
- **Query Creator Promotion Details in Target Collaboration**（需 Read + Manage）：达人 × 商品维度的定向佣金、公开佣金、广告佣金、新旧佣金、视频数、直播数、是否上架、佣金是否生效。

### 2.5 其他联盟数据
- **Search Seller Affiliate Orders** `POST /affiliate_seller/202410/orders/search`：联盟订单 SKU 级明细（达人用户名、计划 ID、内容类型/ID、佣金率、预估/实际佣金基数与佣金、广告佣金、结算状态）；单次时间范围 ≤3 个月；`page_size` 1–100。
- **Compass 离线导出**（异步）：`POST /affiliate_seller/202603/compass/offline_task`（`module_type` CREATOR/BASE，`window_type` PAST_24H/PAST_7_DAYS/PAST_30_DAYS，`end_day` YYYYMMDD 本地时区，`plan_type` ALL/TARGET/OPEN/PARTNER）→ `GET …/compass/offline_tasks?doc_type=` 查状态 → `GET …/offline_tasks/{task_id}/file` 拿 base64 文件。这是唯一的「导出文件」类接口。
- Search Open Collaborations：支持 `sort_field=product_original_price` + `sort_order`。

## 3. 订单导出
- **Get Order List** `POST /order/202309/orders/search`：按状态、创建/更新时间、配送方式、买家等筛；`sort_field` = `create_time` / `update_time`，`sort_order`；`page_size` 1–100；返回整单（金额拆分 `payment.*`、收件地址、状态、时间、运单、`line_items[]` 含商品/SKU/价格/折扣/SKU 图、`is_sample_order` 等，约 210 个字段）。
- **Get Order Detail** `GET /order/202507/orders?ids=`：一次 ≤50 单。
- Get Order Price Details：单笔订单价格明细。
- 没有「生成导出文件」接口，导出 = 分页拉取后自己落表/写 Excel。

## 4. 财务（按订单维度）
- **Get Transactions by Order** `GET /finance/202501/orders/{order_id}/statement_transactions`：单笔订单的收入、费用税费、运费、结算金额，SKU 级拆分（`revenue_breakdown`、`shipping_cost_breakdown`、`fee_tax_breakdown`），文档写「Applicable for all regions' sellers」。
- **Get Statements** → **Get Transactions by Statement**：按账单批量拿每笔订单的结算明细（`sort_field` 只支持 `order_create_time`），适合整月导出。
- **Get Unsettled Transactions**：未结算订单的预估结算。
- Get Payments：文档写「currently unavailable to SEA markets」（PH/TH 不可用）。

## 5. 商品信息导出
- **Search Products** `POST /product/202502/products/search`：按状态、SKU、创建/更新时间、质量分层、审核状态筛；`page_size` 1–100；返回 ID、标题、状态、SKU（价格、库存）、时间、质量分层等（约 67 个字段），**不含图片和描述**。
- **Get Product** `GET /product/202309/products/{product_id}`：完整信息（约 316 个字段），图片在 `main_images`、SKU `sales_attributes[].sku_img`、`size_chart.image`、`description`（HTML）。
- 导出 = Search 拿 ID 列表 → 逐个 Get Product。

## 6. 待核验 / 风险
1. 店铺当前 11 个 scope 是哪些（§7 第 1 条）。
2. PH/TH 跨境店对 Analytics、Order、Finance 接口的可用性（跨境店订单/财务可能走全球卖家维度，未核验）。
3. 达人广场 GMV 货币是本币还是 USD；`gmv` / `units_sold` 的时间窗口。
4. Compass 导出文件格式与列。
5. 星级分布 `ratings` 在 PH/TH 是否有值。

## 7. 实测指令（「API测试」页，格式 `tts-p0-probe {JSON}`）

`shop_id` 用第 1 条返回的店铺 ID 替换。第 2–8 条现有 scope 就能跑；第 9 条起需要先在 Partner Center 新增对应权限包并重新授权店铺，并且要 Lovable 重新部署 tts-p0-probe（1116.148 放开了 raw 的只读白名单）。

**A. 现在就能跑（已有 scope，raw 白名单已覆盖 /affiliate_seller/）**

1. 看店铺 ID 和当前 11 个 scope（返回的 `scopes` 字段）：
   ```
   tts-p0-probe {"action":"shops"}
   ```
2. 达人广场可用排序方式：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/affiliate_seller/202608/marketplace_creators/search/filter","body":{"options":[{"option_type":"OPTION_SORTER"}]}}
   ```
3. 达人广场搜索（核对货币、GMV、粉丝）：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/affiliate_seller/202608/marketplace_creators/search","query":{"page_size":"12"},"body":{"follower_demographics":{"count_range":{"count_ge":10000,"count_le":-1}}}}
   ```
4. 单个达人详情（open_id 从第 3 条结果里取 `creator_open_id`）：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/affiliate_seller/202608/marketplace_creators/达人open_id"}
   ```
5. 申样列表：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/affiliate_seller/202508/sample_applications/search","query":{"page_size":"20"},"body":{}}
   ```
6. 定向计划列表（进行中）：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/affiliate_seller/202508/target_collaborations/search","query":{"page_size":"20"},"body":{"collaboration_status":"ONGOING"}}
   ```
7. 定向计划详情（计划 ID 从第 6 条取）：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/affiliate_seller/202508/target_collaborations/计划ID"}
   ```
8. Compass 达人列表离线导出（建任务 → 查任务 → 下载）：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/affiliate_seller/202603/compass/offline_task","body":{"module_type":"CREATOR","window_type":"PAST_30_DAYS","end_day":20261115,"plan_type":"ALL"}}
   ```
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/affiliate_seller/202603/compass/offline_tasks","query":{"doc_type":"CREATOR"}}
   ```
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/affiliate_seller/202603/compass/offline_tasks/任务ID/file"}
   ```

**B. 需新增权限包 + 重新授权 + Lovable 重新部署后才能跑**

9. 商品星级分布（Analytics）：
   ```
   tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/analytics/202509/shop_products/商品ID/performance","query":{"start_date_ge":"2026-08-17","end_date_lt":"2026-11-16","granularity":"ALL","currency":"LOCAL"}}
   ```
10. 品类热销榜（Bestsellers）：
    ```
    tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/analytics/202511/products/bestselling","query":{"date":"2026-11-14","time_slot":"30D","currency":"LOCAL"}}
    ```
11. 商品列表 / 详情（Product Basic）：
    ```
    tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/product/202502/products/search","query":{"page_size":"20"},"body":{"status":"ACTIVATE"}}
    ```
    ```
    tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/product/202309/products/商品ID"}
    ```
12. 订单列表（Order Information；2026-11-01 至 2026-11-16 UTC）：
    ```
    tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/order/202309/orders/search","query":{"page_size":"20","sort_field":"create_time","sort_order":"DESC"},"body":{"create_time_ge":1793491200,"create_time_lt":1794787200}}
    ```
13. 单笔订单财务明细（Finance Information；订单号从第 12 条取）：
    ```
    tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/finance/202501/orders/订单号/statement_transactions"}
    ```

## 8. 促销活动详情 / 实际对客价（2026-11-16 增补）

**结论**：能用 API 拿到。只要用户给出活动 ID 或活动全名，就能导出活动里每个商品 / SKU 的活动价，不用程序判断哪个是「日常促销」。需新增权限包 **`Promotion Information`**（只读）。

| 步骤 | 接口 | 说明 |
|---|---|---|
| 1. 名称 → ID（用户只给名称时） | Search Promotion Activities `POST /promotion/202309/activities/search` | body：`activity_title`（文档写「No fuzzy matching」，**需填完整名称**，是否大小写/空格敏感待实测）、`status`（NOT_START/ONGOING/EXPIRED/DEACTIVATED）、`activity_type`、`page_size` ≤100、`page_token`。返回 ID、名称、类型、`duration_type`（NORMAL / INDEFINITE 长期）、起止时间、状态、`product_level`。**列表不含商品明细** |
| 2. ID → 商品与活动价 | Get Activity `GET /promotion/202309/activities/{activity_id}` | 返回 `products[]`；无分页参数，文档没写单个活动的商品上限，全量商品能否一次返回**待实测** |

**活动价怎么取（按 `activity_type` × `product_level`）**

| 类型 | 商品级（PRODUCT） | SKU 级（VARIATION） | 实际价 |
|---|---|---|---|
| `FIXED_PRICE` 固定价 | `products[].activity_price{amount,currency}` | `products[].skus[].activity_price` | 直接用 |
| `FLASHSALE` 秒杀 | 同上 | 同上 | 直接用 |
| `DIRECT_DISCOUNT` 折扣 | `products[].discount`（`10` = 打 10% off） | `skus[].discount` | **接口不给折后价**，要用 Get Product 的 SKU 原价 × (1 − discount/100) 自己算（需 Product Basic 权限；舍入规则未核验） |

另有 `quantity_limit`、`quantity_per_user`、`used_quantity`、`status`、`begin_time` / `end_time`。

**边界与风险**
- 结束超过 180 天的 FIXED_PRICE / DIRECT_DISCOUNT / FLASHSALE 活动不返回商品明细。
- 同一商品不能同时在两个冲突的折扣活动里（加品时报错 `17029079` / `17029103`），所以一个商品在同一时间只有一个商家折扣价。秒杀与日常折扣是否算冲突、谁优先，文档没写，**待核验**。
- 「活动价」≠ 买家最终实付：还可能叠加优惠券（Search Coupon List / Get Coupon，同一个权限包）、满减（BMSM）、平台补贴。真实成交价只能看订单 `line_items[].sale_price` 和 `payment.*`。
- 商品表 SKU `price.sale_price` 是面价，跟活动价是两个字段，不会互相覆盖。

**实测指令**（需新增 `Promotion Information` 并重新授权、Lovable 重新部署后才能跑）
```
tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/promotion/202309/activities/search","body":{"status":"ONGOING","page_size":50}}
```
```
tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"POST","path":"/promotion/202309/activities/search","body":{"activity_title":"活动完整名称","page_size":20}}
```
```
tts-p0-probe {"action":"raw","shop_id":"店铺ID","method":"GET","path":"/promotion/202309/activities/活动ID"}
```

## 9. 实测结果（2026-11-16，PH 店，新增 6 个权限包并重新授权后）
- 首次调用 Get Activity 报 `105005`（缺权限），约 3 分钟后用同一 token 重试成功：新开权限有短暂生效延迟。
- 促销：活动共 379 个；日常折扣 `7656714354087446293`（FIXED_PRICE / VARIATION / ONGOING），Get Activity 一次返回全部商品，无分页；价格只在 SKU 级，商品级 `activity_price` 只有币种无金额。
- **活动价 ≠ 当时成交价**：抽 9 条 11-01 订单行，7 条「原价 − 商家折扣」≈ 当前活动价 × 0.90，1 条相等，1 条 0.9276。原因未核验（叠加商家券/满减，或活动价事后修改；活动 update_time = 11-16）。实际成交价以订单 `sale_price` 为准。
- 商品 666 个（`sale_price` 为面价）；订单 11-01 起 16,654 单（买家信息已打码）；财务按日结算单，10 张均满足 结算 = 收入 + 费用 + 调整（代码核验）；商品数据 559 个商品，`latest_available_date` = 2026-11-15。

## 10. 只读闸门（2026-11-16 负责人规定）
- `_shared/tts.ts` 的 `ttsAccessCheck` 在每次 TTS 调用前检查：放行 GET 与路径以 `/search` `/filter` `/query` `/check` 结尾的查询类 POST；写接口只放行「定向计划新建 POST `/affiliate_seller/{v}/target_collaborations`」与「修改 PUT `/affiliate_seller/{v}/target_collaborations/{id}`」。
- 其余写接口（生成邀请链接、建会话、发私信、标记已读、冲突处理、删除计划、Compass 建导出任务、促销/商品/订单任何写）一律拦截，返回「只读闸门拦截」。新增写接口须负责人逐条明确确认后再加入 `TTS_WRITE_ALLOW`。

## 11. 对账工具 `recon`（只读）
- `tts-p0-probe {"action":"recon","shop_id":"…","kind":"orders","date":"YYYY-MM-DD"}`：按店铺本地日（PH UTC+8、TH UTC+7）拉当天全部下单订单，自动翻页，每单按 SKU 汇总件数/原价/售价/商家折扣/平台折扣。
- `tts-p0-probe {"action":"recon","shop_id":"…","kind":"statement","statement_id":"…"}`：按结算单拉逐单结算（结算/收入/运费/费用税/调整）。
- 输出为「columns + rows」紧凑格式，整段复制给 Claude，用代码与后台导出的订单表、财务表逐单比对。
