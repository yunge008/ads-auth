// CRUD for staff_sheets (passcode-gated, service_role).
// GET-style:  { action: "list" } -> { staff: StaffRow[] }
// POST-style: { action: "replace", staff: StaffRow[] } -> { ok: true, renamed: [...] }
//
// 关于 sheet_name 这一列（每人一张的建联/剪辑 sheet）：
//   · 填了值 → 该人单独指定，就用这个值；
//   · 留空   → 用「设置 → 飞书表名称」里的模板生成（建联-{同事姓名} 之类）。
// 所以库里存的是「原样」，list 额外返回一个 resolved_sheet_name = 实际会去飞书匹配的名字，
// 让前端和 feishu-read 这类拿着 staff 列表去读表的调用方不用各自再算一遍（算法不一致就会读错表）。
//
// 关于改名：sheet 名变了的时候，库里已有数据要**跟着改名**，不能留成孤儿。
// 登记行按 source_sheet 先删后插，旧名字那批行没人再删，会和新名字那批并存，
// 归属解析把同一批登记当成两次独立建联去算保护期 —— 数字照出，不报错，极难发现。
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";
import { loadSheetConfig, staffSheetName } from "../_shared/sheetConfig.ts";
import { type SheetRename, renameSourceSheets } from "../_shared/sheetRename.ts";

type StaffRow = {
  id: string;
  name: string;
  sheet_name: string;
  active: boolean;
  role?: "BD" | "EDITOR";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      staff?: StaffRow[];
    };
    const action = body.action ?? "list";
    const db = admin();
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    if (action === "list") {
      const { data, error } = await db
        .from("staff_sheets")
        .select("id,name,sheet_name,active,role,sort_order")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      const cfg = await loadSheetConfig(db);
      const staff = (data ?? []).map((r) => {
        const role = (r.role ?? "BD") as "BD" | "EDITOR";
        const resolved = staffSheetName(cfg, role === "EDITOR" ? "EDITOR" : "JIANLIAN", r.name, r.sheet_name ?? "");
        return {
          id: r.id,
          name: r.name,
          // 库里的原样（留空就是留空，不要在这里填上模板结果，否则下次保存就把模板固化成了单独指定）
          sheet_name: r.sheet_name ?? "",
          // 实际会去飞书匹配的名字
          resolved_sheet_name: resolved.name,
          // override = 单独填的 / template = 模板生成的 / none = 定不出来（姓名为空或模板缺失）
          sheet_name_source: resolved.source,
          active: r.active,
          role,
        };
      });
      return json({ staff });
    }

    if (action === "replace") {
      const next = Array.isArray(body.staff) ? body.staff : [];

      // 先记下改动前每个人实际读的是哪张 sheet：下面是整表删了重插，删完就问不到了。
      const cfg = await loadSheetConfig(db);
      const { data: prevRows, error: prevErr } = await db
        .from("staff_sheets")
        .select("id,name,sheet_name,role");
      if (prevErr) throw new Error(prevErr.message);
      const effectiveOf = (r: { name: string; sheet_name: string | null; role?: string | null }) =>
        staffSheetName(cfg, (r.role ?? "BD") === "EDITOR" ? "EDITOR" : "JIANLIAN", r.name, r.sheet_name ?? "").name;
      const before = new Map<string, string>();
      for (const r of (prevRows ?? []) as Array<{ id: string; name: string; sheet_name: string | null; role: string | null }>) {
        before.set(r.id, effectiveOf(r));
      }

      const { error: delErr } = await db
        .from("staff_sheets")
        .delete()
        .not("id", "is", null);
      if (delErr) throw new Error(delErr.message);
      if (next.length > 0) {
        const payload = next.map((r, i) => ({
          id: r.id,
          name: r.name,
          sheet_name: r.sheet_name ?? "",
          active: r.active,
          role: r.role ?? "BD",
          sort_order: i,
        }));
        const { error: insErr } = await db.from("staff_sheets").insert(payload);
        if (insErr) throw new Error(insErr.message);
      }

      // 同一个人（按 id）改动前后实际读的 sheet 变了 → 把库里那批数据一起改名。
      // 按 id 配对而不是按姓名：姓名本身也可能被改。
      const renames: SheetRename[] = [];
      for (const r of next) {
        const from = before.get(r.id);
        if (!from) continue; // 新增的人，没有历史数据要迁
        const to = effectiveOf({ name: r.name, sheet_name: r.sheet_name ?? "", role: r.role ?? "BD" });
        if (to && to !== from) renames.push({ from, to });
      }
      const renamed = renames.length ? await renameSourceSheets(db, renames) : [];

      return json({ ok: true, renamed });
    }

    throw new Error(`未知 action: ${action}`);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    console.error("staff-sheets", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
