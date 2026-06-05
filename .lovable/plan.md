## 目标
新增两个 Tab：**评论内容**、**素材成效**，复用现有 BC / 飞书 / 鉴权基础设施，不改动现有表与逻辑。

---

## 一、TAB「评论内容」

### 数据来源
- 复用 `tiktok_connections` 表中所有 connection 的 `advertiser_ids`
- 调用 TikTok BC API `/comment/list/`（按 advertiser_id 分页拉取）

### 新增 Supabase 表 `tiktok_comments`
字段：`id`, `advertiser_id`, `country`, `comment_id`(unique), `parent_comment_id`, `vid`, `text`, `text_zh`(翻译缓存), `like_count`, `reply_count`, `username`, `avatar_url`, `comment_type`, `comment_create_time`, `pulled_at`, `created_at`, `updated_at`
唯一键：`comment_id`；写入用 upsert。

### 新增 Edge Function
- `tiktok-comments-sync`：遍历所有 connections + advertiser_ids，分页拉取评论 upsert 入库
- `tiktok-comments-translate`：找出 `text_zh IS NULL` 的评论，调用 **Lovable AI Gateway (google/gemini-2.5-flash)** 翻译，结果写回（批量 20 条/请求）

### 前端 `/comments` Route
- 筛选：国家、广告户、评论类型、关键词
- 列：国家 / 广告户 / 评论内容（副行显示中文翻译，灰色小字）/ 点赞 / 回复 / 用户名 / 头像（`<img>`）/ 类型 / 创建时间 / parent_comment_id / VID / 视频URL（`https://www.tiktok.com/@tiktok/video/{vid}`，点击新窗口打开）
- 分页 50 行/页
- 按钮：「同步评论」「翻译未翻译评论」
- Tab key = `"comments"`，加入 `TABS`，纳入账户权限控制

---

## 二、TAB「素材成效」

### 新增 Supabase 表
**`staff_vid_map`**：`id, country, staff_name, vid, source_type('BD'|'EDITOR'), source_sheet, created_at, updated_at`
唯一键：`(country, staff_name, vid, source_type)`

**`sku_product_map`**：`id, country, product_id, product_name, sku_id, merchant_sku, created_at, updated_at`
唯一键：`(country, product_id, merchant_sku)`

**`gmv_max_vid_daily`**：`id, country, advertiser_id, campaign_id, item_group_id, vid, stat_date, creative_delivery_status, cost, gross_revenue, orders, product_impressions, product_clicks, roi, ctr, cvr, cpm, raw_payload, pulled_at, created_at, updated_at`
唯一键：`(advertiser_id, campaign_id, item_group_id, vid, stat_date)`

### 扩展设置页
- 「剪辑同事」配置（复用 `staff_sheets` 模式，加 `role` 字段 `'BD'|'EDITOR'`），或新表 `editor_sheets`。**建议**：加 `role` 字段到现有 `staff_sheets`，减少表数量
- 同一 sheet 名匹配规则保持一致

### 飞书列位（按你的回答）
- **剪辑表**：B=同事, C=日期, D=国家, E=账号, F=SKU, G=VID, H=备注 → 读取 D/B/G 入 `staff_vid_map`，source_type='EDITOR'
- **BD 表**：复用现有逻辑，写入 source_type='BD'
- **SKU 匹配表**（sheet 名固定 "SKU匹配表"）：A=国家, B=商品ID, C=商品名称, D=SKU ID, F=商家SKU

### 新增 Edge Functions
- `feishu-read-editors`：从剪辑同事 sheet 读取 → upsert `staff_vid_map`
- `feishu-read-bd-vids`：复用 `feishu-read` 数据，额外抽取 country/staff/vid → upsert `staff_vid_map` (source='BD')
- `feishu-read-sku`：读取 SKU 匹配表 → upsert `sku_product_map`
- `gmv-max-sync`：参数 `{start_date, end_date}`，按 30 天自动拆分；遍历所有 advertiser_ids 调用 `/gmv_max/report/get/`（维度 campaign_id/item_group_id/item_id/stat_time_day，指标见 MD），计算 roi/ctr/cvr/cpm（分母 0 → null），upsert `gmv_max_vid_daily`
- 不做定时任务，前端手动触发"拉取最近3天"按钮即可

### 前端 `/material-performance` Route
- 顶部按钮：同步剪辑表 / 同步BD表(VID) / 同步SKU表 / 首次回溯(日期范围) / 拉取最近3天
- 筛选：国家、同事、来源类型、VID、商家SKU、商品ID、日期范围
- 折线图：默认按日期展示「消耗 / 收入 / 订单 / ROI」4 条线（recharts，已在依赖中）；选中单 VID 或单同事后图表跟随
- 汇总表（以 `staff_vid_map` 为主表 LEFT JOIN `gmv_max_vid_daily`，再 LEFT JOIN `sku_product_map` on item_group_id=product_id）：国家/同事/来源/VID/商家SKU/商品ID/订单/ROI/消耗/收入/CTR/CVR/展现/点击
- 分页 50 行/页

### 查询接口
- `gmv-max-query` edge function：接收筛选条件，服务端在 Supabase 中做 join + 聚合返回（避免前端拉全表）

---

## 三、不做的事情
- 不动现有 `feishu-read` / `authorize-batch` / 执行授权页面
- 不引入新 secret（TikTok / 飞书 / Lovable AI Key 都已存在）
- 不做定时调度（先用按钮，后续要再加 pg_cron）

---

## 待你确认
1. 翻译方案确定走 **Lovable AI + 入库缓存**？是
2. 「剪辑同事」放在 `staff_sheets` 表新增 `role` 字段，还是新建 `editor_sheets`？**默认采纳：加 role 字段**
3. 「素材成效」的"首次回溯"按钮是否也按 sheet 内 staff_vid_map 全量拉取（即拉所有 advertiser）？默认是
4. 是否需要在「评论内容」Tab 加导出 CSV？默认加
