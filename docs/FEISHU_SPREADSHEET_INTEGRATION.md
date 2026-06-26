# 飞书表接入指南

> 适用场景：新项目需要从飞书多维表格/电子表格读取业务数据，或把处理结果回写到飞书表。本文按本仓库当前实践整理：前端不直连飞书，统一通过 Supabase Edge Function 代理访问飞书 Open API。

## 推荐架构

```text
前端页面 / 定时任务
  -> src/lib/api.ts: invokeFn(...)
  -> Supabase Edge Function
  -> supabase/functions/_shared/feishu.ts
  -> 飞书 Open API
```

这样做有三个原因：

- `FEISHU_APP_SECRET`、表格 token、service role key 只放在 Supabase secrets，避免泄露到浏览器。
- 所有读写都能复用 `_shared/auth.ts` 的口令鉴权，按 tab 权限控制访问。
- 飞书 API 的分页、单元格格式、错误处理集中在后端，前端只拿结构化 JSON。

## 接入前准备

1. 创建飞书自建应用，拿到 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。
2. 给应用开通并授权电子表格权限，至少需要读取表格；如果要回写，还要开启写入权限。
3. 把飞书表分享给该应用，或确认应用所在企业有权限访问目标表。
4. 从表格 URL 里取 spreadsheet token。本仓库的 `getSpreadsheetToken()` 也支持直接填完整 URL。
5. 在 Supabase secrets 配置：

```bash
supabase secrets set FEISHU_APP_ID=xxx
supabase secrets set FEISHU_APP_SECRET=xxx
supabase secrets set FEISHU_SPREADSHEET_TOKEN=xxx
```

如果一个项目要读多张不同表，建议按用途拆 secret，例如：

```bash
supabase secrets set FEISHU_SKU_SPREADSHEET_TOKEN=xxx
supabase secrets set FEISHU_EDITOR_SPREADSHEET_TOKEN=xxx
```

## 当前仓库的公共封装

公共封装在 `supabase/functions/_shared/feishu.ts`：

| 方法 | 用途 |
| --- | --- |
| `getTenantAccessToken()` | 用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 换 tenant access token |
| `getSpreadsheetToken(envName?)` | 从 secret 读取表格 token；支持 raw token 或完整 URL |
| `listSheets(token, spreadsheetToken)` | 查询表格内所有 sheet，返回 `sheet_id` 和标题 |
| `readRange(token, spreadsheetToken, range)` | 读取范围；对开放行范围按 500 行分块，规避飞书约 5000 cells 限制 |
| `writeValues(token, spreadsheetToken, valueRanges)` | 批量覆盖写入指定 range |
| `appendValues(token, spreadsheetToken, range, values)` | 追加行，适合日志表 |
| `corsHeaders` | Edge Function 的 CORS 头 |

新项目优先复用这些函数，不要在每个 Edge Function 里重新写 token、分页和 CORS 逻辑。

## 读表函数模板

最小读表函数结构：

```ts
import {
  corsHeaders,
  getSpreadsheetToken,
  getTenantAccessToken,
  listSheets,
  readRange,
} from "../_shared/feishu.ts";
import { checkAdminPasscode } from "../_shared/auth.ts";

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((s) => (s && typeof s === "object" && "text" in s ? String((s as { text: unknown }).text ?? "") : String(s ?? "")))
      .join("")
      .trim();
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim();
  }
  return String(v).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");

    const token = await getTenantAccessToken();
    const spreadsheetToken = getSpreadsheetToken("FEISHU_SPREADSHEET_TOKEN");
    const sheets = await listSheets(token, spreadsheetToken);
    const sheetId = sheets.find((s) => s.title === "目标sheet名")?.sheet_id;
    if (!sheetId) throw new Error("未找到 sheet：目标sheet名");

    const rows = await readRange(token, spreadsheetToken, `${sheetId}!A2:F`);
    const data = rows
      .map((row) => ({
        country: cellText(row?.[0]),
        product_id: cellText(row?.[1]),
        product_name: cellText(row?.[2]),
      }))
      .filter((row) => row.product_id);

    return new Response(JSON.stringify({ data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

前端调用统一走 `src/lib/api.ts`：

```ts
const data = await invokeFn<{ data: RowType[] }>("your-feishu-function", {
  sheet_name: "目标sheet名",
});
```

不要从浏览器直接请求 `https://open.feishu.cn/open-apis/...`，也不要把飞书 app secret 或表格 token 放进 Vite 环境变量。

## 单元格解析规则

飞书返回的单元格不总是纯字符串。常见情况：

- 普通文本可能是 string。
- 数字、日期可能是 number。
- 富文本可能是 `[{ text: "..." }]`。
- 部分对象可能带 `text` 字段。

因此读表时必须先做 `cellText()` 这类规范化，再做匹配、校验、入库。不要直接 `String(obj)`，否则富文本可能变成 `[object Object]`。

日期列如果可能来自 Excel/飞书序列号，需要单独转换。本仓库 `feishu-read` 里用 `parseDate()` 同时兼容数字序列号、数字字符串和常见日期字符串。

## 读取大范围数据

飞书 values v2 单次响应大约限制 5000 cells。当前 `readRange()` 对形如 `A2:Q` 的开放范围做了 500 行分块：

- 内部空行会保留，保证行号能和飞书原表对上。
- 开放范围遇到连续空块或 API 返回不足一块时停止。
- 最后会裁掉尾部全空行。

如果新项目读列很多，优先缩小列范围，例如 `A2:F`，不要直接读整张表。

## 回写方式

覆盖指定单元格用 `writeValues()`：

```ts
await writeValues(token, spreadsheetToken, [
  {
    range: `${sheetId}!P${rowNumber}:P${rowNumber}`,
    values: [["2026/06/26"]],
  },
  {
    range: `${sheetId}!Q${rowNumber}:Q${rowNumber}`,
    values: [["已处理"]],
  },
]);
```

追加日志行用 `appendValues()`：

```ts
await appendValues(token, spreadsheetToken, `${logSheetId}!A2:I2`, [
  [1, "US", "达人名", "VID", "CODE", "产品", "20260626 12:00:00", "已授权", "同事"],
]);
```

回写要保存源表行号。当前 `feishu-read` 返回 `row_number: i + 2`，因为读取范围从 `A2` 开始；`feishu-writeback` 再用该行号写回 `P/Q` 列。

## 当前仓库可参考的函数

| 函数 | 读取/写入内容 | 关键点 |
| --- | --- | --- |
| `feishu-read` | 素材授权表 | 按人员 sheet 读取 `A2:Q`，校验日期、国家、VID、授权码，返回行号用于回写 |
| `feishu-writeback` | 授权结果回写 | 写 `P/Q` 列；同时更新或追加 `授权记录` sheet |
| `feishu-read-sku` | `SKU匹配表` | 读 `A2:F`，按 `country, product_id, merchant_sku` 去重后 upsert |
| `feishu-read-editors` | 剪辑人员表 | 读 `FEISHU_EDITOR_SPREADSHEET_TOKEN`，按同事名和 VID 校验入库 |
| `feishu-read-bd-vids` | BD sheet VID | 读启用的 BD 人员 sheet，按国家和 VID 校验入库 |
| `staff-sheets` | 人员 sheet 配置 | 不访问飞书，维护数据库里的人员与 sheet 名映射 |

## 新项目落地清单

1. 在 `supabase/functions/` 新建 Edge Function。
2. 复用 `_shared/feishu.ts` 和 `_shared/auth.ts`。
3. 在 Supabase secrets 配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、对应表格 token。
4. 明确 sheet 名、读取范围、列号和业务字段映射。
5. 写 `cellText()`，所有单元格先规范化再处理。
6. 对关键字段做严格校验，例如 VID、国家、商品 ID、授权码。
7. 入库前按业务唯一键去重；明确是“第一条胜出”还是“最后一条胜出”。
8. 需要回写时，读取阶段保留飞书原始行号。
9. 前端统一用 `invokeFn()` 调用，不直接访问飞书 Open API。
10. 部署函数后，用真实 secret 做一次小范围读表/回写验证。

## 常见错误

| 问题 | 原因 | 处理方式 |
| --- | --- | --- |
| `FEISHU_APP_ID / FEISHU_APP_SECRET 未配置` | Supabase secrets 未配置或部署环境不对 | 用 `supabase secrets list` 检查，重新部署函数 |
| `飞书鉴权失败` | app id/secret 错误，或应用被禁用 | 到飞书开放平台确认凭证 |
| `未找到 sheet` | 传的是表格标题，不是 sheet 标题；或应用无权限 | 用 `listSheets()` 打印当前可见 sheet 标题 |
| 读取结果少行 | 范围写错，或列数太多触发限制 | 使用精确范围；开放范围交给 `readRange()` 分块 |
| 富文本变成 `[object Object]` | 直接 `String()` 复杂单元格对象 | 使用 `cellText()` 递归/分段提取文本 |
| 回写错行 | 读取时没有保存原始行号，或过滤后重新编号 | 以读取起始行计算 `row_number`，不要用过滤后数组索引 |
| 本地能打开页面但 API 失败 | 只跑了前端 dev server，没有 Edge Function 环境 | 用 Supabase 本地函数、部署后的函数，或项目约定的全栈 dev 工具验证 |

## 安全约定

- 飞书 app secret、表格 token、service role key 禁止入库。
- Edge Function 必须通过 `_shared/auth.ts` 鉴权；定时任务例外也要用专用 cron key。
- 前端只拿必要字段，不返回整张敏感表给浏览器。
- 写入飞书前尽量做幂等设计，例如按 VID + 授权码更新已有日志行，不盲目重复追加。
- DB schema 改动只新增 migration，不改历史 migration。
