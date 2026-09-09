# 协同开发规则（Claude / Codex / Lovable 共用）

所有 AI 工具开工前**必须先读**：本文件 → `docs/ARCHITECTURE.md` → `docs/PLAN.md`。

---

## Git 分支硬性规则

**本项目默认且强制直接在 `main` 分支开发、提交和推送。**

除非用户在当前对话中**明确要求**「新建分支」「使用 feature branch」或「走 PR」，否则任何 AI 工具（Claude / Codex / Lovable 等）：

* **禁止新建分支**
* **禁止主动使用 feature branch**
* **禁止创建 Pull Request**
* **禁止把最终修改留在临时分支、session 分支或自动生成分支**
* **禁止因为“改动较大”“更安全”“最佳实践”等理由自行决定建立分支**
* **禁止执行 `git checkout -b ...`**
* **禁止执行 `git switch -c ...`**
* **禁止执行任何创建新 Git branch 的等价命令**

用户没有明确要求分支时，**一律视为要求直接修改 `main`**。

### 每次会话开工前必须确认分支

任何文件修改之前，必须先执行：

```bash
git status
git branch --show-current
```

如果当前分支不是 `main`，必须先执行：

```bash
git switch main
```

如果环境不支持 `git switch`，则执行：

```bash
git checkout main
```

然后同步最新代码：

```bash
git pull --ff-only origin main
```

确认当前分支为 `main` 后才能开始修改文件。

### Claude Code Web / 云端 Agent 特别规则

如果 Claude Code Web、Codex 云端环境或其他 Agent 在新会话启动时自动创建了类似以下临时分支：

```text
claude/...
codex/...
session/...
agent/...
feature/...
```

**不要继续在该分支开发。**

必须先尝试切换回：

```bash
git switch main
git pull --ff-only origin main
```

之后所有修改、commit、push 都必须发生在 `main`。

如果平台本身强制禁止切换到 `main`，或者强制要求通过临时分支 / PR 工作，则：

1. **不要自行创建更多分支**
2. **不要因为平台默认行为就认为用户允许使用 PR**
3. 明确告诉用户：当前执行环境强制使用隔离分支，无法遵守本项目“直接修改 main”的规则
4. 在用户没有明确授权前，不要擅自改变本项目的 Git 工作流

### 提交与推送目标

默认提交目标始终是：

```bash
git add <本次修改文件>
git commit -m "[身份] 描述"
git push origin main
```

Claude 使用：

```text
[claude]
```

Codex 使用：

```text
[codex]
```

Lovable 自动提交保持 Lovable 自己的提交格式即可。

**不得将临时分支 push 后要求用户手动 merge。**

只有用户在当前任务中明确要求使用分支或 PR 时，才允许偏离上述规则。

---

## 仓库与同步

* 远端：https://github.com/yunge008/ads-auth.git
* Lovable 双向同步 `main` 分支。
* Claude / Codex / Lovable 的共同主工作分支都是 `main`。
* **开工前必须先确认自己位于 `main`，然后 `git pull --ff-only origin main`。**
* **完工后立刻 commit + `git push origin main`。**
* Lovable 会随时往 `main` 推提交，拖得越久冲突越多。
* 小步提交，一次 commit 只做一件事。
* Commit message 前缀标明身份：

  * Claude：`[claude]`
  * Codex：`[codex]`
  * Lovable：自动提交不要求额外前缀
* **无论改动大小，默认都直接在 `main` 完成。**
* 跨多文件重构、DB schema 修改等大改动，也**不得自行创建 feature 分支**。
* 只有用户明确指定「这个任务走 feature branch / PR」时，才能新建分支。

---

## 分工建议（按文件域划分，避免交叉修改）

| 域                                            | 默认负责           | 说明              |
| -------------------------------------------- | -------------- | --------------- |
| `src/components/ui/`、页面样式与布局                 | Lovable        | UI 原型与视觉调整      |
| `supabase/functions/`、`supabase/migrations/` | Claude / Codex | 后端逻辑、API 集成、SQL |
| `src/routes/api/`、`src/lib/`                 | Claude / Codex | 服务端路由与业务逻辑      |
| 页面业务逻辑（routes/*.tsx 中的数据处理）                  | 谁认领谁做          | 先在 PLAN.md 认领   |

跨域改动前，先看 `PLAN.md` 里有没有人正在改同一文件。

---

## 工作流程（每次会话）

### 1. 确认并同步 main

首先执行：

```bash
git status
git branch --show-current
```

如果不是 `main`：

```bash
git switch main
```

然后：

```bash
git pull --ff-only origin main
```

**没有确认位于 `main` 前，不允许修改任何项目文件。**

### 2. 阅读项目文档

按顺序阅读：

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/PLAN.md`

### 3. 认领任务

读 `docs/PLAN.md`：

* 找到自己的任务；或
* 新建任务并写上：

  * 执行者名字
  * 状态
  * 涉及文件

开始跨域修改前，检查是否有人正在修改相同文件。

### 4. 开发

正常开发。

如果修改了：

* 架构
* 数据库表结构
* 核心数据流
* API 架构

则同步更新：

```text
docs/ARCHITECTURE.md
```

### 5. 完工

完成后：

1. 更新 `docs/PLAN.md` 状态
2. 在 `docs/WORKLOG.md` **追加**一行
3. 更新 `src/lib/version.ts`
4. 检查修改
5. commit
6. push 到 `origin/main`

例如：

```bash
git status
git diff
git add <本次涉及文件>
git commit -m "[claude] 完成本次任务"
git push origin main
```

### 6. 任务中断

任务即使没有完全完成，也不要把未同步工作长期留在本地。

需要：

1. 在 `PLAN.md` 标注：

   * 进行中
   * 已完成内容
   * 剩余事项
2. 在合理可运行状态下 commit
3. push 到 `main`

让下一个工具能够继续接手。

---

## 并发修改与冲突处理

因为 Claude / Codex / Lovable 都可能修改 `main`，每次开始工作和 push 前都要注意远端变化。

### 开工前

必须：

```bash
git pull --ff-only origin main
```

### 工作过程中

如果任务持续时间较长，在最终提交前再次检查远端是否有新提交。

必要时：

```bash
git fetch origin
```

查看：

```bash
git status
git log --oneline --decorate -10
```

### push 被拒绝时

如果：

```bash
git push origin main
```

因为远端已有新提交而失败：

**禁止 force push。**

不要执行：

```bash
git push --force
git push -f
```

应先同步远端并解决冲突。

优先：

```bash
git pull --rebase origin main
```

确认冲突解决且代码正常后：

```bash
git push origin main
```

如果发现冲突涉及 `PLAN.md` 中其他工具正在进行中的任务，不要擅自覆盖对方代码。

---

## 推送后的收尾清单（人工步骤分类）

**每次改动 commit + push 完，如果这次改动还需要任何后续手动步骤才能生效，必须主动列出来，分成两类，不要遗漏、不要让用户自己猜。**

### A 类：用户能自己在 Supabase 后台操作的

能省 Lovable 积分的操作优先走这类。

典型场景：

* 跑新 migration SQL
* 查 Edge Function 日志
* 查看 Logs
* 使用 SQL Editor
* 检查数据库数据

必须给出：

1. 具体入口路径，例如：

   * `Supabase Dashboard → SQL Editor`
   * `Supabase Dashboard → Edge Functions → Logs`
   * Lovable `Cloud` 面板对应子页面
2. 需要粘贴或执行的具体内容

例如需要执行 SQL 时：

**不要只说：**

```text
去跑一下 migration。
```

必须把需要执行的 SQL 原文完整提供出来，让用户能够直接复制执行。

### B 类：必须让 Lovable 执行的

本项目目前没有除 Lovable 外的相关部署权限时，归入 B 类。

典型场景：

* 修改了 `supabase/functions/**`
* Edge Function 需要重新部署
* 其他只有 Lovable 当前能够执行的部署操作

必须提供一段：

**可以直接复制粘贴进 Lovable 聊天框的完整指令。**

必须明确：

* 要部署什么
* 哪几个函数
* 是否涉及其他操作

不要使用：

```text
麻烦重新部署一下。
```

这种模糊表述。

应该明确写出具体函数名列表。

### 不需要人工操作时

如果只是：

* 纯前端修改
* 普通业务代码
* 文档修改
* Lovable 会自动从 `main` 同步的修改

必须明确告诉用户：

```text
不需要做任何事，Lovable 同步 main 后自动生效。
```

不要让用户误以为还需要额外检查或手动部署。

---

## 硬性约定

* `src/routeTree.gen.ts` 自动生成，**禁止手改**
* 新页面 = 在 `src/lib/tabs.ts` 注册 tab key + 建路由文件
* 文件路由规范见 `src/routes/README.md`
* **不要建 Next.js 风格目录**
* Edge Function 必须经 `_shared/auth.ts` 的 `verifyPasscode` / `checkAdminPasscode` 鉴权
* 前端统一使用 `src/lib/api.ts` 的 `invokeFn` 调用 Edge Function
* DB 改动只走 `supabase/migrations/` 新文件
* **禁止修改历史 migration**
* `.env` 不入库
* 新增密钥需在 Supabase secrets 配置，并在 `PLAN.md` 注明
* TikTok API 调用必须复用 `gmv-max-sync` 里的 `ttGet`（限速 + 退避），不要绕过
* 不要删除或重写他人「进行中」任务涉及的文件
* 有疑问在 `PLAN.md` 对应任务下留言
* **禁止 force push `main`**
* **禁止为了完成任务自行创建新分支**
* **禁止任务完成后要求用户手动 merge Claude / Codex 自动创建的分支**

---

## 版本号规则

**每次代码或文档改动都要更新版本号：**

```text
src/lib/version.ts
```

字段：

```text
APP_VERSION
```

格式：

```text
MMDD.NNN
```

规则：

* `MMDD` = 当天日期
* `NNN` = **全局递增序号**
* `NNN` **不按日期重置**
* 同一天多次修改继续递增
* 第二天也继续使用上一次的 NNN + 1
* Claude / Codex / Lovable 三方修改都必须遵守
* 不得漏更新
* 修改版本号前先读取当前 `APP_VERSION`，在现有序号基础上 `+1`
* 不允许凭猜测填写版本号

例如当前：

```text
0908.127
```

下一次改动，即使日期已经是 0909，也应该是：

```text
0909.128
```

而不是：

```text
0909.001
```

---

## 文档职责

| 文件                     | 用途         | 写法                 |
| ---------------------- | ---------- | ------------------ |
| `AGENTS.md`（本文件）       | 协作规则，少改    | 改规则需人确认            |
| `docs/ARCHITECTURE.md` | 架构事实，随代码更新 | 覆盖式编辑              |
| `docs/PLAN.md`         | 计划 + 任务认领板 | 编辑自己的任务行           |
| `docs/WORKLOG.md`      | 完工日志       | **只追加，不修改**（天然无冲突） |

---

## 指令优先级

发生冲突时，按以下优先级执行：

1. 用户在**当前对话中明确提出的要求**
2. `AGENTS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/PLAN.md`
5. AI 工具自己的默认开发习惯

例如：

如果 Claude / Codex 默认认为：

```text
大改动应该创建 feature branch
```

但用户没有明确要求创建分支，则必须服从本文件规则：

```text
直接在 main 修改。
```

AI 工具自己的“最佳实践”“安全建议”“默认 Git workflow”**不得覆盖本项目明确规定的 main-only 工作方式**。

---

## 最终提交前 Git 检查

每次准备 commit + push 前必须检查：

```bash
git branch --show-current
git status
```

必须确认输出中的当前分支是：

```text
main
```

如果不是 `main`：

**不要直接提交和 push 当前分支。**

先切换/迁移本次修改到 `main`，确认修改位于 `main` 后再提交。

最终 push 必须是：

```bash
git push origin main
```

而不是：

```bash
git push origin <临时分支>
```

任务完成的标准是：

**修改已经进入远端 `origin/main`。**

“代码已经提交到 Claude 自动生成的 branch，等待用户 merge”不算任务完成。

---

## Imported Claude Cowork project instructions
