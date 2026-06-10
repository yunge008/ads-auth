## 现状校准（先把 PLAN.md 摆正）

线上实际状态（已核查）：

| 旧任务 | 真实状态 | 依据 |
| --- | --- | --- |
| feishu-data 默认 tab=gmv、日期=昨天 | ✅ | 早前已合入 |
| pg_cron 两条 job 已写入 | ✅ | `cron.job` 查到 `gmv-max-sync-yesterday`(0 19 * * *) + `gmv-max-sync-today-hourly`(0 0-18 * * *)，另外还有第三条 `gmv-max-hourly-refresh`(5 * * * *) 直接打 sync |
| gmv_max_vid_daily 加 4 条索引 | ✅ | 8 条索引齐全：`country_stat_date / adv_stat_date / vid / stat_date(brin)` 全在 |
| 前端「上次自动刷新时间」 | ⬜ 未做 | grep 不到对应文案，不动它，保持待办 |

→ 实施阶段先在 PLAN.md 把前 3 条移到「已完成」，第 4 条保留 ⬜。

---

## 新需求：每日北京 08:00 自动授权 + 飞书机器人通知

### 1. 鉴权（采纳 Claude 修正）

复用现成的 vault secret 机制：

- 新路由 `src/routes/api/public/hooks/authorize-cron.ts` 从 `vault.decrypted_secrets` 读 `gmv_max_cron_secret`（直接抄 gmv-max-cron.ts 第 55–66 行）。
- 给 `feishu-read` / `authorize-batch` / `feishu-writeback` 三个函数加 8 行 cron bypass（抄 gmv-max-sync 第 234–242 行）：
  ```ts
  const cronKey = req.headers.get("x-cron-key") ?? "";
  let cronAuthed = false;
  if (cronKey) {
    const { data: ok } = await admin().rpc("verify_gmv_cron_key", { _key: cronKey });
    if (ok === true) cronAuthed = true;
  }
  if (!cronAuthed) await checkAdminPasscode(req, "home");
  ```
- 不引入 `ADMIN_PASSCODE` 注入假设。

### 2. authorize-cron 路由逻辑

```text
1. apikey 校验（== SUPABASE_PUBLISHABLE_KEY，沿用 gmv-max-cron）
2. 读 vault → cronKey
3. 读 staff_sheets where active=true（service role）
4. POST feishu-read { staff:[...], include_done:false } → materials
5. 若 materials 内 status ∈ {待授权,API错误} 且有 advertiser_id+auth_code 的为 0
   → 走"今日无待授权素材"通知 + 落库 + 返回
6. 循环最多 4 轮、整体硬预算 10 分钟：
   - 取本轮 targets = materials 中 status∈{待授权,API错误} 且有 advertiser_id+auth_code
   - 若 targets 为 0 → 收敛，break
   - POST authorize-batch { items: targets } → results
   - 把 results merge 回 materials（按 id）
   - 「无授权账号」不参与循环、不计入失败、不重试
7. POST feishu-writeback { items: materials.filter(WRITE_STATUSES) }
8. 统计：
   success = count(status=='已授权')
   no_account = count(status=='无授权账号')
   failed = total - success - no_account  // 即各种"代码*/视频不可见/API错误"
   failedBreakdown = groupBy(失败行, status) → {状态: 数量}
9. 发飞书机器人通知（见下）
10. upsert authorize_cron_state（id='daily'）
```

特殊处理：
- 「无授权账号」素材在 step 5 计数时已排除在 targets 之外，所以**不会浪费轮数**（采纳 Claude 第 2 条）。
- 内存物料 id 使用 feishu-read 返回的现成 `id`。
- 10 分钟硬预算超时 → 记 `errors.push({error:'budget exceeded at round N'})`，继续走 step 7–10，保证一定有通知。

### 3. 飞书机器人通知（富文本 post）

读 `FEISHU_BOT_WEBHOOK` secret（用户已给值）；未配置 → `console.warn` 跳过、路由仍正常返回。

正常消息 payload：
```json
{
  "msg_type": "post",
  "content": {"post": {"zh_cn": {
    "title": "📋 自动授权完成（20260610 08:07）",
    "content": [
      [{"tag":"text","text":"✅ 成功 12 条 ｜ ❌ 失败 3 条 ｜ ⚠️ 无授权账号 1 条"}],
      [{"tag":"text","text":"失败原因：代码过期 ×2、视频不可见 ×1"}],
      [{"tag":"a","text":"查看授权记录","href":"https://lnihysziqd.feishu.cn/sheets/ZWA7s1iqTh63j1t6PJfcuPnunBe?sheet=1SBV4u&rangeId=1SBV4u_pPvTdlNlkj&rangeVer=1"}]
    ]
  }}}
}
```
- 第 2 行（失败原因）仅当 failed>0 才追加；
- 第 3 行（链接）仅当 failed>0 才追加；
- 「今日无待授权素材」场景：标题相同，content 只有一行 `今日无待授权素材`。

### 4. 数据库

新 migration `supabase/migrations/<ts>_create_authorize_cron_state.sql`：

```sql
CREATE TABLE public.authorize_cron_state (
  id           text PRIMARY KEY,
  last_run_at  timestamptz NOT NULL DEFAULT now(),
  success      integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  no_account   integer NOT NULL DEFAULT 0,
  rounds       integer NOT NULL DEFAULT 0,
  errors       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.authorize_cron_state TO service_role;
ALTER TABLE public.authorize_cron_state ENABLE ROW LEVEL SECURITY;
-- 不加 SELECT TO authenticated：本项目不用 Supabase Auth，前端读数走 edge function（service role）
-- 与 gmv_max_sync_state 一致

CREATE TRIGGER authorize_cron_state_touch
  BEFORE UPDATE ON public.authorize_cron_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
```

采纳 Claude 第 4 条：不发明无用的 authenticated 权限。

### 5. pg_cron Job（SQL 走 supabase--insert，不入 migration）

北京 08:00 = UTC 00:00 → cron `0 0 * * *`。仿照现有两条 job 写法，**额外加 `timeout_milliseconds`**：

```sql
select cron.schedule(
  'authorize-daily-0800',
  '0 0 * * *',  -- UTC 00:00 = 北京 08:00
  $$
  SELECT net.http_post(
    url := 'https://project--1cc99db7-f223-464e-9d06-be2aad0bd229.lovable.app/api/public/hooks/authorize-cron',
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_3EjrcsK9Xp3ILAzRnhED1g_PGogg4VK"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 600000
  );
  $$
);
```

采纳 Claude 第 3 条。

### 6. Secret

build 模式下执行 `secrets--add_secret(["FEISHU_BOT_WEBHOOK"])`，让用户在表单里粘贴 webhook URL。

### 7. 协同文档同步

- `docs/ARCHITECTURE.md`：
  - 「页面」表追加 `/api/public/hooks/authorize-cron`
  - 「关键数据流」追加：`pg_cron(北京 08:00) → authorize-cron → feishu-read → authorize-batch(≤4 轮) → feishu-writeback → 飞书机器人通知 + authorize_cron_state`
  - 「数据库主要表」追加 `authorize_cron_state`
  - 在 `gmv-max-sync` 后注明 cron bypass 同样应用于 `feishu-read / authorize-batch / feishu-writeback`
- `docs/PLAN.md`：把 3 条已完成任务移到「已完成」，新增本次任务并标 ✅
- `docs/WORKLOG.md`：追加一行

## 实施顺序

1. `secrets--add_secret(["FEISHU_BOT_WEBHOOK"])`
2. `supabase--migration`：建 `authorize_cron_state` 表
3. 改 `feishu-read / authorize-batch / feishu-writeback` 各加 8 行 cron bypass
4. 新建 `src/routes/api/public/hooks/authorize-cron.ts`
5. `supabase--insert` 写 pg_cron job（带 timeout_milliseconds=600000）
6. 用 `invoke-server-function`（POST `/api/public/hooks/authorize-cron` 带 apikey）冒烟一次，看飞书有没有收到 + 表里有没有写入；不行就看 `server-function-logs`
7. 同步 3 份 docs；commit & push

## 待你点头

无新疑问，按上述执行。
