# Listing 评价监控（TAB）计划

> 2026-11-25 claude 立项。状态：📝 计划 + UI 原型待负责人确认，**未写代码、未部署**。
> UI 原型（示例数据）：https://claude.ai/artifact/7EqAfexGgfr81oi2wEzHHn

## 1. 需求（负责人 2026-11-25）

用商店接口监控各 listing 评价，先做一个 TAB：listing 评分走势、每日评价数量、每日评价平均分；按站点、时间段筛选。

## 2. 接口核对（2026-11-25 重新拉 Partner Center 文档，当前 414 个 API）

| 结论 | 依据 | 状态 |
|---|---|---|
| 仍**没有**评价内容接口（文字 / 晒图 / 单条评价时间） | 文档树 414 个 API 名称核对：带 review 的只有售后审核、样品审核、联盟活动商品审核；带 comment 的只有视频评论（Post-view Search Video Comments）。`Customer Service API Review Requirements` 是应用审核要求，不是接口 | ✅ 文档已核 |
| 星级分布只有 `Get Shop Product Performance Detail` `GET /analytics/202509/shop_products/{product_id}/performance` | 入参 `start_date_ge`（含）、`end_date_lt`（不含）、店铺注册时区 `YYYY-MM-DD`、`granularity` ALL/1D、`currency`；返回 `performance.ratings[]{stars:1_STAR…5_STAR, count, percentage(0–1, 4 位小数)}`、`latest_available_date` | ✅ 文档已核 |
| **`ratings` 不在 `intervals[]` 里**，是整个区间一份；`granularity=1D` 只拆销售/流量，不拆星级 | 返回字段层级：`^^ratings` 与 `^^intervals` 同级 | ✅ 文档已核 → **每日数据必须按天单独调用（start=d, end=d+1）** |
| 「区间内的评价」是按评价发生日还是订单日统计 | 文档只写 "ratings within the chosen start_date_ge and end_date_ge" | ⚠️ 未核验 |
| 没有店铺自己商品的「当前展示评分」字段 | Get Product / Search Products / Performance List 均无 rating；`Bestselling Products` 有 `rating` 但只返回品类榜前 100（含他店） | ✅ 文档已核 → 累计评分只能自己用分布算 |
| 单次可查的最大日期跨度、能回溯多早 | 文档未写 | ⚠️ 未核验 |
| scope | `data.shop_analytics.public.read`：10 个店（JP、MX-AR、MX-NE、MX-SJ、MY、PH、SG、TH、US、VN）全部已有（`tts_shops.scopes` 查询） | ✅ 已核 |
| 跨境店能否调通、`ratings` 是否有值 | 同系列 `shop_videos/batch_performance` 已在 9 站实跑可用（1125.292/296），本接口未实跑 | ⚠️ 未核验 |

## 3. 实现方案（待确认后再写代码）

### 3.1 数据
- `tts_listing_products`：shop_id、product_id、title、主图、status、更新时间。来源 `POST /product/202502/products/search`（每日 1 次）。
- `tts_listing_rating_daily`：shop_id、product_id、date（店铺时区）、s1..s5 条数、fetched_at；主键 (shop_id, product_id, date)。
- `tts_listing_rating_base`：shop_id、product_id、基线截止日、s1..s5（上线时一次性拉历史分布，用于「累计评分」）。
- 体量：s1..s5 五个 int，单店千级 listing × 365 天 ≈ 百万行以内；只存有评价的天（0 条不落库）可再降一个量级。

### 3.2 抓取
- 每日 cron（走 `/api/public/hooks/*` 服务端路由，**新增后需负责人点 Publish**），按店分片：
  1. 商品列表同步；
  2. 每个 LIVE 商品拉 `[今天-7, latest_available_date]` 逐日分布，覆盖迟到 / 删除的评价（重拉 7 天 = 每品每天 7 次调用，量大时改为「先拉 7 天 ALL，与库内 7 天合计相同则跳过逐日」）。
- 回填：先每品 1 次 ALL（回填区间）判断有无评价；有评价的区间二分到天，调用量 ≈ 有评价天数 × log₂(天数)，不做全量逐日。
- 限速：复用 `_shared/tts.ts` `ttsCall`（≥350ms 间隔 + 36009002 退避）。
- 估算（`sku_product_map` 10 店 2,534 个商品，**含下架品，实际 LIVE 数未核验**）：每日每品 1 次 ≈ 2,534 次 ≈ 15 分钟串行；全量逐日回填 90 天 ≈ 22.8 万次 ≈ 22 小时（因此采用二分方案）。

### 3.3 页面（见原型）
- 筛选：站点（全部 / 10 站，MX 三店分开）、时间段（近 7/30/90/180 天 + 自定义）、商品名 / ID 搜索；点表格行看单个 listing。
- 指标：评价数、区间平均分（按条数加权）、累计评分（截至结束日）、差评占比（1–2 星），均带较上一同长度区间变化。
- 图：评分走势（累计 / 近 30 天滚动切换）、每日评价数（按星级堆叠）、每日平均分（0 条留空，点大小=条数）。
- 表：站点、商品、评价数、区间均分、累计评分、累计变化、1–2 星条数、星级分布条，可排序。
- 口径说明进默认折叠的「说明」TAB；指标口径用「?」。

## 4. 🙋 需负责人决策

1. **评分走势口径**：A 累计评分（最接近前台展示分，需基线回填） / B 近 30 天滚动 / C 两者都要（原型做了切换）。
2. **监控范围**：A 全部 LIVE 商品 / B 仅近 N 天有订单的商品（调用量更小，下架品不看）。
3. **回填长度**：90 天 / 180 天 / 能拉多早拉多早（最大跨度未核验，实测后定）。
4. 是否需要**差评提醒**（如单品单日出现 1–2 星推飞书），本期不做则留 P2。

## 5. 上线前必须实测（⚠️ 未核验项）

用 API 测试页 `tts-p0-probe raw` 跑（只读，raw 白名单已含 `/analytics/`）：
1. PH、TH 各取 1 个热销品：30 天 ALL 一次 vs 30 次单日之和，逐星级是否相等（可加性 → 决定每日口径是否成立）。
2. 同一商品 365 天 ALL 是否报 28001022（最大跨度）。
3. 基线分布算出的均分 vs Seller Center / 前台展示分。
4. 跨境店（JP/MY/PH/SG/TH/US/VN）与本土店（MX 三店）各 1 店是否返回 `ratings`。
