## 目标

回到「每条素材一行、单一广告户」的模型，但保留合并后的 TikTok 授权链接设置表（含国家列）。

## 改动

### 1. `supabase/functions/feishu-read/index.ts`
- 去掉「按匹配广告户拆行」的循环。
- 每条飞书素材最多生成 1 行；当 `accByCountry.get(country)` 有多个时，取第一个（并在响应里附 `duplicate_countries: string[]` 用于前端提示）。
- 未匹配仍为 `无授权账号`。

### 2. 设置表「国家」列唯一性
- 同一 `country` 同时只能挂在一个 `advertiser_id` 上。
- 在 `set_country` 时（`supabase/functions/tiktok-connections/index.ts`）做检查：若该 country 已被其他 advertiser 占用，返回 409 + 提示「国家已被 XXX 占用，请先解除」。
- `AccountsTable.tsx`：保存时若后端 409 用 toast 提示；表格中重复占用的行加红色徽标。

### 3. 前端 `src/routes/index.tsx`
- 删除「授权后按结果聚合 / 拆分错误」相关代码（之前规划中尚未引入，保持当前 1:1 行为）。
- 「待授权账户」面板仍按当前 `country → advertiser` 1:1 展示。

### 4. 不动
- `authorize-batch`：已按 `id → advertiser_id` 1:1 处理，无需改动。
- `advertiser_countries` 表结构不变（仍是 advertiser_id+country 复合主键，仅靠应用层保证 country 唯一）。

## 不在范围
- 多国/多账户聚合错误信息（用户已收回）。
- 数据库层加 `UNIQUE(country)` 约束（先用应用层校验，避免迁移阻塞；如后续需要再补）。
