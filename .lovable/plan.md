## 目标

把单一 `ADMIN_PASSCODE` 升级为「多账号 + 按 Tab 授权」体系，所有账号共用同一套 TikTok 授权账户和飞书配置；admin 在设置页管理账号和权限；普通账号登录后只看到被授权的 Tab。未来新增 Tab 时只需在权限列表里勾选即可。

## 数据库

新表 `app_accounts`：
- `id uuid pk`
- `name text`（显示名）
- `passcode_hash text`（SHA-256 存储，避免明文）
- `is_admin boolean`（管理员=全部权限）
- `tab_permissions text[]`（可访问的 tab key 列表，如 `["home","settings","new_feature_x"]`）
- `active boolean`
- `created_at / updated_at`

RLS：service role only（沿用现有模式，edge function 用 service role 访问）。

**首次迁移**：自动创建一条 admin 账号，passcode 取当前 `ADMIN_PASSCODE` 的 hash，权限全开 —— 保证旧用户无缝过渡。

## 后端 Edge Functions

### 1. 改造 `_shared/auth.ts`
- `checkAdminPasscode(req)` → `verifyPasscode(req): Promise<{accountId, name, isAdmin, tabs:string[]}>`
- 从 header `x-admin-passcode` 取 passcode → hash → 查 `app_accounts` → 返回账号信息
- 失败抛 401；未激活抛 403
- 新增 `requireTab(account, tab)` 在受限接口里调用

### 2. 现有 functions
- 所有 functions 改用 `verifyPasscode`，并按 tab 校验：
  - `staff-sheets` / `tiktok-connections` / `bc-list-advertisers` / `tiktok-connection-save` → 需 `settings` tab
  - `feishu-read` / `authorize-batch` / `feishu-writeback` → 需 `home` tab
- admin 自动通过所有检查

### 3. 新 function `app-accounts`
- `op: "me"` → 返回当前账号信息（前端 bootstrap 时调用）
- `op: "list" / "create" / "update" / "delete"` → 需 admin
- create/update 时如果传入 `passcode` 字段，hash 后存

## 前端

### 1. `src/lib/api.ts`
- 新增 `currentAccount` 全局状态（zustand-lite store）
- 改 `PasscodeGate`：输入密码后调用 `app-accounts { op:"me" }`，成功后把账号信息缓存到 store + localStorage
- 401 仍清空 passcode 重新输入

### 2. `src/components/AppShell.tsx`（Tab 导航）
- 读取 `currentAccount.tabs`，过滤渲染哪些 Tab
- admin 一律全部显示
- 当前已有 Tab: `home`（/）、`settings`（/settings）；后续新 Tab 只要在这里注册 + 加进权限列表

### 3. `src/routes/_authenticated` 或路由层 guard
- 进入路由时如果当前账号没有权限，跳回首个有权限的 Tab + toast 提示

### 4. 设置页新增「账号管理」面板（仅 admin 可见）
- 表格：名称 / 密码（仅新建/重置时填）/ 是否管理员 / Tab 权限（多选 checkbox）/ 启用 / 操作
- 复用现有 `StaffTable` 的样式风格

## 技术细节

- Passcode hash：Web Crypto `crypto.subtle.digest("SHA-256", ...)`，加项目级 salt（写在 edge function 常量里）
- Tab key 集中定义在 `src/lib/tabs.ts`：`export const TABS = [{key:"home", label:"授权操作", path:"/"}, {key:"settings", label:"设置", path:"/settings"}]`，前后端共享同一份定义
- 旧 `ADMIN_PASSCODE` 环境变量保留作为「root 救援密码」，永远拥有 admin 权限，避免误删 admin 账号后锁死

## 不在范围

- 不做 Supabase Auth 集成（保持轻量 passcode 模式，符合现有产品形态）
- 不做密码强度校验、找回密码、登录历史

## 后续如何加新 Tab

1. 在 `src/lib/tabs.ts` 加一条 `{key:"new_x", label:"新功能", path:"/new-x"}`
2. 建路由文件 `src/routes/new-x.tsx`
3. admin 进设置页给需要的账号勾上 `new_x` 即可
