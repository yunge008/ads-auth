# 协同开发规则（Claude / Codex / Lovable 共用）

所有 AI 工具开工前**必须先读**：本文件 → `docs/ARCHITECTURE.md` → `docs/PLAN.md`。

## 仓库与同步

- 远端：https://github.com/yunge008/ads-auth.git ，Lovable 双向同步 `main` 分支。
- **开工前必须 `git pull`，完工后立刻 commit + push**。Lovable 会随时往 main 推提交，拖得越久冲突越多。
- 小步提交，一次 commit 只做一件事。Commit message 前缀标明身份：`[claude]` / `[codex]` / lovable 自动提交不带前缀。
- 大改动（跨多文件的重构、改 DB schema）走 feature 分支 + PR；小改动可直接 main。

## 分工建议（按文件域划分，避免交叉修改）

| 域 | 默认负责 | 说明 |
| --- | --- | --- |
| `src/components/ui/`、页面样式与布局 | Lovable | UI 原型与视觉调整 |
| `supabase/functions/`、`supabase/migrations/` | Claude / Codex | 后端逻辑、API 集成、SQL |
| `src/routes/api/`、`src/lib/` | Claude / Codex | 服务端路由与业务逻辑 |
| 页面业务逻辑（routes/*.tsx 中的数据处理） | 谁认领谁做 | 先在 PLAN.md 认领 |

跨域改动前，先看 PLAN.md 里有没有人正在改同一文件。

## 工作流程（每次会话）

1. `git pull`
2. 读 `docs/PLAN.md`：找到自己的任务，或新建任务并**写上自己的名字 + 状态 + 涉及文件**
3. 开发；改了架构/表结构 → 同步更新 `docs/ARCHITECTURE.md`
4. 完工：更新 PLAN.md 状态 → 在 `docs/WORKLOG.md` 追加一行 → commit + push
5. 任务中断时也要 push，并在 PLAN.md 标注「进行中/剩余事项」，让下一个工具能接手

## 硬性约定

- `src/routeTree.gen.ts` 自动生成，**禁止手改**
- 新页面 = 在 `src/lib/tabs.ts` 注册 tab key + 建路由文件（文件路由规范见 `src/routes/README.md`，不要建 Next.js 风格目录）
- Edge Function 必须经 `_shared/auth.ts` 的 `verifyPasscode`/`checkAdminPasscode` 鉴权；前端统一用 `src/lib/api.ts` 的 `invokeFn` 调用
- DB 改动只走 `supabase/migrations/` 新文件，不改历史 migration
- `.env` 不入库；新增密钥需在 Supabase secrets 配置并在 PLAN.md 注明
- TikTok API 调用必须复用 `gmv-max-sync` 里的 `ttGet`（限速+退避），不要绕过
- 不要删除/重写他人「进行中」任务涉及的文件；有疑问在 PLAN.md 任务下留言

## 文档职责

| 文件 | 用途 | 写法 |
| --- | --- | --- |
| `AGENTS.md`（本文件） | 协作规则，少改 | 改规则需人确认 |
| `docs/ARCHITECTURE.md` | 架构事实，随代码更新 | 覆盖式编辑 |
| `docs/PLAN.md` | 计划 + 任务认领板 | 编辑自己的任务行 |
| `docs/WORKLOG.md` | 完工日志 | **只追加，不修改**（天然无冲突） |

## Imported Claude Cowork project instructions
