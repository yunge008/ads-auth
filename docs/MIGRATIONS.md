# 已执行 migration 台账

**为什么有这个文件**：本项目的 migration 由人工在 `Supabase Dashboard → SQL Editor` 里执行，
跑完的文件会从 `supabase/migrations/` 删掉，避免下次误跑。文件删了，"这条到底跑没跑、
什么时候跑的、干了什么" 就没有记录了 —— 这张表就是那份记录。

**规则**：
- 用户说 "xxx 跑了" → 在这里追加一行（**只追加，不修改历史行**），然后从 `supabase/migrations/` 删掉该文件。
- 没确认跑过的，文件留在 `supabase/migrations/` 里，不进这张表。
- 表里已有的行 = 数据库里已经生效的结构，查 "某个视图/RPC 当初怎么定义的" 看这里对应的提交。

**要看 SQL 原文**：文件虽然删了，git 历史里永远还在。按下表的「引入提交」查：

```bash
git show <提交号>:supabase/migrations/<文件名>
```

| 执行日期 | 文件名 | 引入提交 | 干了什么 |
| --- | --- | --- | --- |
| 2026-09-18 | `20260916140000_attribution_v3_fact_tables.sql` | `f2fe884` | V3 事实层：归因事实表、`attribution_manual_rules`（VID 级人工强归因）、`attribution_manual_decisions`（人工达人判定） |
| 2026-09-18 | `20260916140100_attribution_v3_identity_stages.sql` | `f2fe884` | V3 身份层 + 归属区间层建表（含区间不重叠的排他约束） |
| 2026-09-18 | `20260916160000_protection_90d_consistency.sql` | `282d241` | 保护期统一 90 自然天；SQL 第二实现 `attribution_protection_owner_90d` + 校验视图 `attribution_protection_check_90d` |
| 2026-09-18 | `20260917120000_registry_audit_views.sql` | `61802c8` | 登记盘点视图（按 sheet／按 BD 的登记行数与日期分布） |
| 2026-09-18 | `20260918110000_needs_posted_at_exact_again.sql` | `7bbcac9` | `attribution_norm_creative_type` 收成精确匹配（撤回包含式匹配），与 TS 两处归一化对齐 |
| 2026-09-18 | `20260918140000_attribution_lookup.sql` | `42dfa98` | 归因查询 RPC `attribution_lookup`（VID／昵称 → 每月归给谁），返回单 JSON 规避 PostgREST 1000 行截断 |
| 2026-09-18 | `20260918160000_protection_no_date_rows.sql` | `6c520d1` | A4：无日期的登记行不参与归属判定，SQL 侧与 TS 的 `resolveOwnership` 对齐 |
| 2026-09-18 | `20260918170000_feishu_sheet_config.sql` | `fa8b620` | 新表 `feishu_sheet_config`（飞书表名配置，8 行初始数据），去掉 sheet 别名兜底 |
