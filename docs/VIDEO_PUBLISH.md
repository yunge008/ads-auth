# 视频发布（带 TikTok Shop 商品链接）— 开发计划

> 状态：📝 计划已定（2026-11-18 负责人确认），P0 实测未开始。接口字段未核验项以本文「未核验」标注为准，P0 实测后覆盖更新。
> 资料来源：Partner Center 文档目录 https://partner.tiktokshop.com/docv2/page/affiliate-creator-api-overview 、https://partner.tiktokshop.com/docv2/page/get-shoppable-video-status-202509 、https://partner.tiktokshop.com/docv2/page/get-shoppable-video-precheck-result-202601 ；Content Posting API https://developers.tiktok.com/doc/content-posting-api-reference-direct-post

## 2026-11-18 接口核验（官方方案文档 Shoppable_video_Integration_Solutions.md + tts_open_toolkit 0.1.7 内置 OAS）
已核验：Host `open-api.tiktokglobalshop.com`，签名同 `_shared/tts.ts` 的 `ttsSign`；header `x-tts-access-token` = **达人侧 access_token（Get Access Token 时 user_type=1）**；无 shop_cipher。
官方号 = `TIKTOK_SHOP_OFFICIAL_ACCOUNT`（每店 1 个），渠道号 = `TIKTOK_MARKETING_ACCOUNT`（每店最多 4 个），两者挂车商品均取 Get Shop Products。

| 步骤 | Method Path | 方案文档版本 | OAS 版本 | 关键字段 |
|---|---|---|---|---|
| 账号类型 | GET `/affiliate_creator/{v}/profiles` | 202508 | 202405/202508 | `user_type` |
| 可挂商品 | GET `/affiliate_creator/{v}/shop_products` | 202509 | 202509 | page_size 1–20、page_token、title_keyword |
| 上传 | POST `/affiliate_creator/{v}/videos/video_files`（multipart `data`） | 202505 | 202505 | ≤100MB，9:16–16:9；**≥10MB 须走大文件分片方案（文档链接是飞书内部文档，未拿到）**；返回 video_file.id / md5 |
| 封面（可选） | POST `/affiliate_creator/{v}/photos/photo_files` | 202511 | — | ≤10MB |
| 预检 | POST `/affiliate_creator/{v}/videos/precheck_task`（file_id + product_id） | 202511 | 202511 | **每账号 API 渠道 50 次/天**；同一 file_id 重复预检也扣次数 |
| 预检结果 | GET `/affiliate_creator/{v}/videos/precheck_tasks/{task_id}` | 202511 | 202511/202601 | PROCESSING 轮询；FAIL 必须拦截发布 |
| 发布 | POST `/affiliate_creator/{v}/videos` | **202607** | **202505** | `video_info{file_id, title≤4000, cover_uri?, cover_timestamp_ms?, music_id?, is_ai_generated?}` + `product_link_info{product_id, title<30 且无标点/emoji}`；返回 video.id、quota |
| 状态 | GET `/affiliate_creator/{v}/videos/{video_id}/status` | 202509 | 202509 | |

- 版本不一致：发布接口方案文档写 202607，OAS 只有 202505 → 默认用 202607，P0 实测失败再退 202505。
- 合规要求（IF-161111）：系统必须提供「取消授权」入口。
- 发布错误码：16011007/16011069（锚点标题过长/含标点）、170001020（发帖频率超限）、170001014/015（风控）等，原文见方案文档。

### 阻塞项（未核验）：所需 scope
- 方案文档和工具包 OAS 都没写 shoppable video 接口需要哪个 scope。
- 负责人截图（Partner Center →「管理 内部开发 的权限范围」，共 31 项）中**没有任何视频/内容发布类 scope**；creator 类只有 `creator.affiliate.link.write`、`creator.data.live.read.public`、`creator.affiliate.share_link.read`。
- 结论：当前 App 不能直接勾选开通，需要单独申请。拿到 scope 前 P0 无法开始。
- `tts_open_toolkit` 的 devapi（可查/管理 App 权限）登录令牌只能存 macOS Keychain / Windows DPAPI，云端 Linux 容器用不了；负责人可在自己电脑上用它查。

## Context
需要并行新增「通过 API 发布挂商品链接（小黄车）视频」的能力，发布账号 = 我们自己的官方号/矩阵号；
后期由自研视频发布前端工具调用本项目 Edge Function。要求与现有功能（授权 / GMV Max / 归因 / 外联 / SEA 库存 / 上架）互不影响。

已确认的用户决策：
- 链接 = TikTok Shop 商品锚点（shoppable video）
- 账号 = 自有官方号/矩阵号
- 接入 = 前端工具调 Edge Function（本项目只做后端 + 最小管理/测试页）

## API 选型结论
| 线路 | 能否挂商品链接 | 结论 |
|---|---|---|
| TikTok Content Posting API（developers.tiktok.com，`/v2/post/publish/video/init`） | 否（只有 brand_content_toggle 等） | 不用 |
| Business API `/business/video/publish/`（现有 `_shared/tiktok.ts` 线路） | 未找到商品锚点参数（未核验） | 不用 |
| **TikTok Shop Partner API · Affiliate Creator「Shoppable Video」** | 是 | **采用** |

Shoppable Video 流程（来源 Partner Center 文档目录，页面为 JS 渲染，**请求/响应字段未核验**，P0 实测确认）：
1. Upload Shoppable Video（上传视频文件，multipart）
2. Create Video Precheck Task → Get Shoppable Video Precheck Result `GET /affiliate_creator/{202511|202601}/videos/precheck_tasks/{task_id}`（PROCESSING 需轮询；FAIL 返回 issues）
3. Post Shoppable Video（挂 product_id 发布）
4. Get Shoppable Video Status（文档页版本 202509）
- Scope：`creator.video.write`（已核验出现在文档）；授权主体是**达人侧（creator）授权**，不是现有 `tts_shops` 的卖家店铺授权 —— 需要每个官方号单独走 creator 授权。
- 未核验 / P0 必须实测：creator 授权 URL 与 token 换取是否同为 `auth.tiktok-shops.com/api/v2/token/get`；是否需要 shop_cipher；当前 App 是否已开通 Affiliate Creator 类 API 权限（可能需在 Partner Center 申请）；视频格式/大小限制；官方号发布自家店商品是否需先加入橱窗（Add Showcase Products API）。

## 隔离原则（不影响其他功能）
- 全部新文件，前缀 `video-publish`；只对共享文件做**一处追加**：`supabase/functions/_shared/tts.ts` 的 `TTS_WRITE_ALLOW` 加 shoppable video 写接口白名单（正则限定 `/affiliate_creator/\d+/videos/...`），不改签名/限速逻辑。
- 复用 `_shared/tts.ts` 的 `ttsCall`（签名、≈3 QPS 限速、429/36009002 退避、写操作超时不重试）、`ttsExchangeCode` / `ttsRefreshToken`（若 P0 确认 creator token 同端点）。
- 不碰 `_shared/tiktok.ts`（Business API）、不碰 `tts_shops` 表结构。
- 新 DB 表独立，RLS 开、无 policy，仅 service role（同 `tts_shops` 做法）。

## 分阶段

### P0：接口实测（只读 + 单条真实发布），不建页面
- 实测手段：在 `tts-p0-probe` 已有 `raw` action 上实测，不新建函数（一次性逻辑走最简）。
- 交付：`docs/VIDEO_PUBLISH.md` 记录每个接口的真实 path/版本/字段/错误码，标「已核验/未核验」。
- 需用户：在 Partner Center 确认 App 开通 Affiliate Creator 权限与 `creator.video.write` scope；用 1 个官方号完成 creator 授权；提供 1 条测试视频 + 1 个商品 ID。

### P1：后端
- Migration（新文件）`supabase/migrations/2026MMDD_video_publish.sql`：
  - `video_publish_accounts`：id, handle, nickname, region, creator_open_id, access_token, refresh_token, access_expire_at, refresh_expire_at, scopes text[], active, created_at
  - `video_publish_jobs`：id, account_id, client_ref（外部前端幂等键，UNIQUE(account_id, client_ref)）, video_source(url|storage path), caption, product_ids text[], status(PENDING/UPLOADING/PRECHECK/PRECHECK_FAIL/POSTING/PUBLISHED/FAILED), upload_id, precheck_task_id, precheck_issues jsonb, post_id/video_id, error, request_log jsonb, created_by, created_at, updated_at
  - `video_publish_api_keys`：id, name, key_sha256, active（给外部前端工具用）
- Edge Function `supabase/functions/video-publish/index.ts`，actions：
  - `auth_url` / `exchange`（creator 授权，回调页 `src/routes/oauth.video.callback.tsx`）
  - `accounts`（列表/启停）、`refresh_token`
  - `create_job`（幂等：同 client_ref 直接返回已有 job）
  - `advance`（状态机推进一步：上传→预检→轮询预检→发布→查状态；单次调用不超 80s，返回 next 供续跑，同 gmv-max-sync 的 remaining_* 思路）
  - `job` / `jobs`（查询）
- 鉴权：管理端走 `_shared/auth.ts` `checkAdminPasscode(req, "video-publish")`；外部前端走 `x-video-api-key`（sha256 比对 `video_publish_api_keys`），**只放行** create_job / advance / job / jobs / accounts(只读)。
  - API Key 明文只在创建时返回一次，库里只存 sha256；可停用。
- 视频来源：前端工具传可公网访问的 video_url，函数下载后 multipart 上传（Edge Function 内存限制，大文件需 P0 确认上限；超限方案再议）。
- 纯函数 `_shared/video-publish.ts`（状态机迁移、参数校验）+ `video-publish.test.ts`（零依赖断言，同现有 test 风格），`deno test supabase/functions/_shared/`。

### P2：最小管理/测试页
- `src/lib/tabs.ts` 注册 `{ key: "video-publish", label: "视频发布", to: "/video-publish" }`
- `src/routes/video-publish.tsx`：账号授权与列表、单条发布测试表单、任务列表（状态/预检问题/错误）、API Key 管理。前端统一 `invokeFn`（`src/lib/api.ts`）。
- 新增 `src/lib/videoPublishApi.ts` 封装调用。

### P3：外部前端工具接入文档
- `docs/VIDEO_PUBLISH.md` 补「对外 API」章节：endpoint、header、create_job/advance/job 请求响应示例、状态码、幂等规则、轮询建议。

## 关键文件
新增：`supabase/functions/video-publish/index.ts`、`supabase/functions/_shared/video-publish.ts`(+test)、`supabase/migrations/*_video_publish.sql`、`src/routes/video-publish.tsx`、`src/routes/oauth.video.callback.tsx`、`src/lib/videoPublishApi.ts`、`docs/VIDEO_PUBLISH.md`
追加修改：`_shared/tts.ts`（仅 TTS_WRITE_ALLOW）、`src/lib/tabs.ts`（一行）、`docs/ARCHITECTURE.md`、`docs/PLAN.md`、`docs/WORKLOG.md`、`src/lib/version.ts`
不改：`_shared/tiktok.ts`、`tts_shops`、其它业务函数与页面

## 已拍板（用户 2026-11-18 确认）
1. 外部前端鉴权：**新增 API Key**（`x-video-api-key` + `video_publish_api_keys`）。这是对 AGENTS.md「Edge Function 必须经 verifyPasscode/checkAdminPasscode」的**规则变更**，仅限 video-publish 函数；执行时在 AGENTS.md 硬性约定该条下注明例外，ARCHITECTURE.md 同步。
2. Git：先 `git switch main && git pull --ff-only origin main`，所有提交 push 到 `origin/main`；若平台禁止切换/推送 main，停下告知，不自建分支、不建 PR。
3. Secrets：沿用 `TTS_APP_KEY`/`TTS_APP_SECRET`；若 P0 发现 creator 类 API 需独立 App，再新增 secret 并在 PLAN.md 注明。

## 验证
- `deno test supabase/functions/_shared/`（新增状态机/校验用例 + 现有用例全过）
- `bun run build`（或 `npm run build`）确认前端编译与 routeTree 生成
- P0：用 1 个官方号 + 1 条视频 + 1 个商品真实发布，在 TikTok App 确认视频挂车，记录 request_id
- 回归：`ttsAccessCheck` 对原有白名单接口结果不变（tts.test.ts）

## 完工后人工步骤（预告）
- A 类：Supabase SQL Editor 执行 video_publish migration 全文（届时给出原文）
- B 类：Lovable 部署 `video-publish`、`tts-p0-probe`（若改）以及所有 import `_shared/tts.ts` 的函数（tts-export、tts-listing、outreach-*、sea-inventory、tts-p0-probe）—— 因白名单追加需重新部署才生效（届时给出完整指令）
