// 新品推广 / 产品推广计划：用脚本代替表内公式计算寄样数、返素材数、剪辑素材数（方案④）。
//
// 背景：两张表约 1400 个单元格每格用 INDIRECT 拉 5 列 × 55000 行再跑 REGEXMATCH/FILTER/UNIQUE，
// 加上同事表 U 列等重公式，整本表重算超过半小时。这里在内存里按同一口径算一遍，再一次性回写数值。
// 口径见 _shared/xinpin-calc.ts（唯一变更：新品推广寄样数改为去重，负责人 2026-11-28 定）。
//
// 请求体：
//   mode            "dryrun"（默认，只算 + 与公式值逐格对比，不写表）| "write"（回写）| "compute"（只算，返回结果）
//   tables          ["xinpin","chanpin"]，默认两张都算
//   data_sheet      数据来源表（建联-* / 新品推广 / 产品推广计划 原表）：表 token、/sheets/ 或 /wiki/ 链接；默认 env XINPIN_DATA_SPREADSHEET
//   clip_sheet      剪辑台账表（E/F 列来源）；默认取新品推广 E 列 IMPORTRANGE 里的链接
//   target_sheet    回写目标表；默认 env XINPIN_TARGET_SPREADSHEET
//   xinpin_target   回写的 sheet 名，默认「新品推广-脚本」
//   chanpin_target  回写的 sheet 名，默认「产品推广计划-脚本」
//   xinpin_sheet / chanpin_sheet  配置与模板 sheet 名，默认「新品推广」「产品推广计划」
//   compare         dryrun 对比哪张 sheet 的公式值：默认原 sheet（新品推广 / 产品推广计划），可传 {xinpin:"新品推广-公式优化",chanpin:"..."}
//   confirm_source_write  写源表时必须原样填源表 token，否则拒绝（永远不默认写源表）
//
// 鉴权：管理口令（verifyPasscode）或 pg_cron 的 x-cron-key（只允许 write，目标表取 env）。
import { corsHeaders } from "../_shared/feishu.ts";
import { verifyPasscode } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { apiCalls, runXinpin } from "../_shared/xinpin-run.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const t0 = Date.now();
  try {
    const isCron = await cronAuthed(req);
    if (!isCron) await verifyPasscode(req, "settings");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return json(await runXinpin(body, { isCron, env: (k) => Deno.env.get(k) }));
  } catch (e) {
    const err = e as Error & { status?: number };
    return json({ ok: false, error: err.message, elapsed_ms: Date.now() - t0, feishu_api_calls: apiCalls }, err.status ?? 500);
  }
});
