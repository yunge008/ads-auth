# 新品推广 / 产品推广计划 提速：公式优化（①） vs 脚本回写（④）

> 2026-11-28 claude。源表「达人建联登记表」`ZWA7s1iqTh63j1t6PJfcuPnunBe` **只读**；所有实验在复制表（wiki `TjU6wseT4iHOX0kwIgYcveRnnXd` → 表 `GdXDsqLz0hdmFYtcqbUcd861ndg`）上做。

## 1. 口径（脚本与公式一致，唯一变更已标注）

| 表 | 列 | 口径 |
|---|---|---|
| 新品推广 | 寄样数量 | 建联-<BD> 表：B 发样日期 ∈ [上架日, +89]、D 用户名非空、K 正则精确匹配 SKU、C = 站点或以「站点-」开头；**按 站点\|发样日期\|K\|D 去重**（**变更**：原公式按行计数不去重，负责人 2026-11-28 定去重。复制行=同一次寄样的后续素材行） |
| 新品推广 | 返素材数量 | N 视频登记日期 ∈ [上架日, +89]、P VID 非空、K 匹配、站点同上；按 D\|K\|P 去重 |
| 新品推广 | E/F 剪辑素材 | 剪辑台账 `EHmlsMg33heiiOtb4kZcvpg8nJg` 的「小莫 / 王诗蔓」：C 日期 ∈ [上架日, +29]、D 地区非空、G VID 非空、F 匹配 SKU；按(地区,VID)去重后按地区计数，多→少；无数据 =「无素材」 |
| 产品推广计划 | 寄样 / 返素材 | 同上，但窗口 = [B 开始, C 结束]（空=不限），站点 = G 列**精确**匹配；寄样按 发样日期\|D\|K 去重（原公式本来如此）；只填负责该站点同事的两列 |

输出格式：新品推广 `PH: 5`，多站点换行（含 0 的站点也列），全 0 输出 0；产品推广计划输出数字。所有文本比较先 TRIM（含 CHAR(160)）。

## 2. 方案 ④：Edge Function `xinpin-tuiguang-calc`

- 代码：`supabase/functions/xinpin-tuiguang-calc/index.ts`（鉴权）+ `_shared/xinpin-run.ts`（编排）+ `_shared/xinpin-calc.ts`（纯计算）。
- `mode=dryrun` 逐格对比公式值，返回 `[cell, formula_value, script_value]`；`mode=write` 用 values_batch_update 回写；默认目标 sheet「新品推广-脚本」「产品推广计划-脚本」；写源表必须 `confirm_source_write`=源表 token。
- 统计格判定 = 原表该格有统计公式（含 `"建联-"` 或 `IMPORTRANGE`）；第 3 行「寄样数量/返素材数量」决定口径。
- 定时：`xinpin-calc-hourly`（每小时 :25，migration `20261128140000`，**建好即停用**）→ `/api/public/hooks/xinpin-calc-cron`；失败发飞书。
- 环境变量：`XINPIN_DATA_SPREADSHEET`（数据来源表）、`XINPIN_TARGET_SPREADSHEET`（回写表），cron 只认环境变量。

## 3. 结果

见本次 WORKLOG 与对话汇报（耗时、API 次数、一致率）。
