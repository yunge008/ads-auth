## 三项改动计划

### 1. 已获取数据查询 TAB 默认行为

`src/routes/feishu-data.tsx`：

- `<Tabs defaultValue="vids">` → 改为 `defaultValue="gmv"`，进入页面默认打开 GMV Max。
- `GmvDailyReport` 初始日期由 "近 7 天" 改为 "昨天"：`start = end = 昨日 (today - 1)`。
- 国家筛选默认 "全部"（已是该值，无需改动）。

---

### 2. GMV Max 抓取规则与自动调度

#### 现有抓取逻辑（先说明给你看，不改）

- **入口**：Edge Function `gmv-max-sync`，单令牌串行，每次 HTTP 请求 15 s 超时，整次调用默认 ≤ 80 s（留 20 s 给 upsert 与回包），超时前返回 `remaining_advertiser_ids / remaining_campaign_ids`，由前端续跑。
- **节流**：≤ 3 QPS + "Too many requests" 指数退避（3/6/12/24 s）。
- **抓取维度**：`campaign_id × item_group_id × item_id × stat_time_day`，每个广告户先取所有 campaigns，再分批拉报表，按窗口 ≤ 30 天拆分。
- **写入**：先按 `(country, advertiser_id, stat_date)` 删除该范围内旧行，再 upsert，避免重复累计。
- **当前调度**：**没有任何 pg_cron / 计划任务**，全靠前端按钮（"开始回溯 / 最近 3 天"）触发；之前对话提到"每小时刷新"实际上没有落地为 cron。

#### 你提出的调度计划评估

- 凌晨 3:00 跑昨天 1 天数据；
- 当天 08:00–次日 02:00 每小时跑当日 1 天数据 → 共 **19 次/天**，加凌晨 1 次 = 每天 **20 次** 全量同步。

**API 量评估**：
- 每次仅 1 天窗口，每个 advertiser 调用次数 ≈ `1（campaign 列表）+ ceil(campaigns/20)（报表批次）`。
- 以现有最大账号 PH（≈ 2400 campaigns）为例：单次 ≈ 1 + 120 = 121 次调用 / advertiser。其他账号小得多，整体一次全量假设均值 ≈ 200–400 调用。
- 一天 20 次 ≈ **4000–8000 次 API 调用**，仍在 TikTok BC API 默认 QPD 限额（通常单 token 数万）之内，**节奏合理**。
- **风险点**：大账号单次 80 s 跑不完，过去靠前端续跑兜底。在 cron 场景需要后端自己续跑。

#### 实施方案

1. **新增公开路由** `src/routes/api/public/hooks/gmv-max-cron.ts`（HTTP POST）：
   - 鉴权：`apikey` header = Supabase anon key（`/api/public/*` 已绕过平台层鉴权；额外校验 anon key 防误调）。
   - 入参 `{ mode: "yesterday" | "today" }`：
     - `yesterday` → `start_date = end_date = today_local - 1`（按账号时区或统一 UTC+8，下文用 UTC+8）；
     - `today` → `start_date = end_date = today_local`。
   - 内部循环调用 `gmv-max-sync`（HTTP 调用 Edge Function），遇到 `remaining_advertiser_ids / remaining_campaign_ids` 自动续跑，最多 10 轮、整体硬上限 5 分钟，超时记录到日志后退出（下一小时自然补齐）。
   - 写入 `gmv_max_sync_state` 一行 `last_cron_run_at / mode / rows / errors`，前端可显示"上次自动刷新时间"。

2. **pg_cron 调度**（用 `supabase--insert` 写两条 job，不进 migration）：
   - `gmv-max-sync-yesterday` `0 3 * * *`（UTC+8 ⇒ cron 用 `0 19 * * *` UTC）→ POST `{mode:"yesterday"}`；
   - `gmv-max-sync-today-hourly` `0 0-18,23 * * *` UTC（= UTC+8 的 08:00–次日 02:00 每小时）→ POST `{mode:"today"}`。
   - 提前 `CREATE EXTENSION IF NOT EXISTS pg_cron, pg_net;`（一般已开）。

3. **前端**：保留"开始回溯 / 最近 3 天"按钮做手动补数；GMV Max 卡片右上角显示"上次自动刷新：HH:mm（昨日 / 今日）"。

---

### 3. 数据量增长后的查询性能优化

当前慢的根因：`gmv_max_vid_daily` 行数线性增长（≈ advertisers × campaigns × item_groups × items × days），所有筛选都是表扫描 + 聚合。

#### 短期（成本低，立即做）

1. **索引**（migration）：
   - `gmv_max_vid_daily(country, stat_date)`
   - `gmv_max_vid_daily(advertiser_id, stat_date)`
   - `gmv_max_vid_daily(vid)`
   - `gmv_max_vid_daily(stat_date)` BRIN（按时间顺序写入，BRIN 比 B-tree 省空间）
2. **服务端聚合已存在**（`gmv-max-daily-report`），继续保持前端只调聚合接口，不要在前端做 group by。
3. **分页严格走服务端**，`page_size ≤ 100`；列筛选前置（先 `stat_date BETWEEN` + `country = ?`，再其它）。
4. **历史归档**：>180 天的明细可以归档到 `gmv_max_vid_daily_archive`，主表只留近 180 天，查询默认范围限制。

#### 中期（数据量再上一个量级时）

5. **预聚合物化表** `gmv_max_daily_rollup(country, advertiser_id, stat_date, cost, gross_revenue, orders, row_count, status_counts jsonb)`：
   - 由 `gmv-max-sync` 在写完明细后顺手 `INSERT ... ON CONFLICT DO UPDATE` 维护；
   - 「GMV Max 日报」直接查 rollup，量级从百万→千级，瞬时返回。
6. **VID 级 rollup**（可选）`gmv_max_vid_rollup(country, vid, stat_date, ...)` 服务素材成效页。
7. **分区表**：`gmv_max_vid_daily` 按 `stat_date` 月分区（PARTITION BY RANGE），配合 BRIN + 分区裁剪，单次查询只扫当月。

#### 建议执行顺序

立即做：1 + 2 + 3；本次只加索引 migration，业务代码不动。  
观察 2–4 周，如果日报/素材成效仍卡，再上 5（rollup 表，工作量中）；再卡上 7（分区，工作量大）。

---

### 待你确认

- 调度时区按 **UTC+8** 计算？（cron.schedule 用 UTC 表达式，我会自动换算）
- 索引这次先只加 1+2+3 中的 4 条索引，不动业务代码？还是直接把 rollup 也做了？
