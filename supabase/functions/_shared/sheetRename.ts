// 改 sheet 名时，把库里已有的数据**跟着改名**，而不是留成孤儿、更不是删掉。
//
// 起因：登记行按 `source_sheet` 先删后插。飞书把「建联-阿南」改成「建联表-阿南」之后，
// 下次同步写的是新名字，旧名字那 1500 多行没人再删它 —— 同一批登记在库里存了两份，
// 归属解析会当成「两个人各登记过一次」去算 90 天保护期，数字照常出，没有任何报错。
//
// 一开始的做法是同步时把这些孤儿行盘出来让人去删。那是错的方向：
//   · 改名是正常运维动作，不该产出一堆「待人工清理」的垃圾；
//   · 让人拿着 DELETE 去操作六万行量级的历史登记，删错无法回滚。
// 正确做法是改名时就地迁移：UPDATE 一句把旧名字改成新名字，数据连续、孤儿不产生、
// 下次同步直接接着写新名字那批行。旧名字那批历史登记一行都不会丢。

/** 最小可用的 db 形状，理由同 sheetConfig.ts 里的 DbLike */
// deno-lint-ignore no-explicit-any
type DbLike = { from: (t: string) => any };

/** 存了 source_sheet 的表，改名时都要跟着改 */
const SHEET_REF_TABLES = ["creator_registry", "connection_material_registry"] as const;

export type SheetRename = { from: string; to: string };

export type SheetRenameResult = {
  from: string;
  to: string;
  /** 各表实际改名的行数；表不存在或没有匹配行则为 0 */
  moved: Record<string, number>;
};

/**
 * 把若干组 sheet 改名落到数据库里。
 *
 * 只处理「两边都非空且确实不同」的改名；`to` 已经存在同名数据时也照改 ——
 * 那种情况说明两张 sheet 合并了，合并后按 source_sheet 先删后插仍然是自洽的。
 *
 * 单条改名失败不会中断其余的：改名是尽力而为的收尾动作，不该让「保存人员表」整个失败。
 * 失败的那条会体现为 moved 全 0，调用方可以据此提示。
 */
export async function renameSourceSheets(
  db: DbLike,
  renames: SheetRename[],
): Promise<SheetRenameResult[]> {
  const out: SheetRenameResult[] = [];
  const seen = new Set<string>();
  for (const r of renames) {
    const from = (r.from ?? "").trim();
    const to = (r.to ?? "").trim();
    if (!from || !to || from === to) continue;
    // 同一组改名只做一次（模板改名时多个同事可能算出同一对）
    const dedupeKey = `${from}${to}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const moved: Record<string, number> = {};
    for (const table of SHEET_REF_TABLES) {
      try {
        const { data, error } = await db
          .from(table)
          .update({ source_sheet: to })
          .eq("source_sheet", from)
          .select("id");
        moved[table] = error ? 0 : ((data ?? []) as unknown[]).length;
      } catch {
        moved[table] = 0;
      }
    }
    out.push({ from, to, moved });
  }
  return out;
}
