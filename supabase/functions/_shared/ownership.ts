// 达人归属与外联保护规则 v1.2 的纯计算核心（A 外联线）。规则原文：docs/CREATOR_OWNERSHIP_RULES.md。
// 只做计算、不读写数据库，便于单测与在 precheck / 每晚重算中复用。
// 不影响 GMV 归因引擎（_shared/attribution.ts），两者口径的差异按规则 §7 走 B 线单独处理。
//
// 日期一律为北京时间自然日字符串 YYYY-MM-DD。

export type Settings = {
  cooldownDays: number; // §2 两次联盟渠道触达最少间隔（天）
  protectDays: number; // §3.3 保护期（含第 N 天）
  unrepliedTagDays: number; // §8.1 「未回复」标签在最近一次触达满 N 天后消失
};
export const DEFAULT_SETTINGS: Settings = { cooldownDays: 14, protectDays: 90, unrepliedTagDays: 90 };

/** 站点池：PH / PH2 / PHL 合并为 PH，其余按站点（§1） */
export function sitePool(site: string): string {
  const s = String(site ?? "").trim().toUpperCase();
  if (s === "PH2" || s === "PHL" || s.startsWith("PH")) return "PH";
  return s;
}

// ── 日期工具 ───────────────────────────────────────────────────────────────
const DAY = 86_400_000;
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
/** 时间戳（秒或毫秒或 ISO）→ 北京时间自然日 */
export function bjDate(t: number | string | Date): string {
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const mdCn = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;

// ── 输入 ──────────────────────────────────────────────────────────────────
/** 触达（§1）：联盟渠道 = 系统群发 / 系统定向 / 插件群发；外部渠道需登记 */
export type Touch = {
  date: string;
  at?: string; // 精确时间（ISO），用于同一天内判断回复归属；缺省按当天 00:00
  bd: string;
  channel: "affiliate" | "external";
  shopId?: string; // 回复归属按同一店铺会话判断（§3.5）
};
/** 建联成功与续期事件 */
export type OwnershipEvent = {
  date: string;
  at?: string;
  type: "reply" | "sample_approved" | "sample_shipped" | "vid_recovered" | "external_success";
  bd?: string; // reply 不填时按 §3.5 推断
  shopId?: string;
};
export type Input = {
  touches: Touch[];
  events: OwnershipEvent[];
  /** 离职 BD → 最后工作日 L（§4） */
  lastWorkday?: Record<string, string>;
  /** 未判定的冲突涉及的 BD（来自冲突表，status=待判） */
  openConflictBds?: string[];
};

// ── 输出 ──────────────────────────────────────────────────────────────────
export type Conflict = { date: string; type: string; bds: string[]; detail: string };
export type OwnerSpan = { bd: string; start: string; startReason: string; end?: string; endReason?: string };
export type State = {
  owner: string | null; // 当前跟进权 BD（保护期内）
  protectUntil: string | null; // 含当天
  anchor: string | null;
  anchorType: string | null;
  lastTouch: { bd: string; date: string } | null; // 最近一次联盟渠道触达
  cooldownUntil: string | null; // 冷却最后一天（含），次日起可再发
  tag: string; // §8.1 归属标签（公共池为空）
  history: OwnerSpan[];
  conflicts: Conflict[]; // 本次计算新发现的冲突（写入冲突表前需去重）
};

// 2026-11-17 负责人确认：发样 = 审批样品，算认领（与申样批准同等）
const CLAIM = new Set(["reply", "sample_approved", "sample_shipped", "vid_recovered", "external_success"]);
const REASON: Record<string, string> = {
  reply: "达人回复", sample_approved: "申样批准", vid_recovered: "回收素材", external_success: "外部渠道登记", sample_shipped: "发样",
};
const key = (x: { date: string; at?: string }) => x.at ?? `${x.date}T00:00:00+08:00`;

/** §3.5 回复归给回复之前、同一店铺会话里最近一次联盟渠道触达的 BD */
export function replyBd(reply: OwnershipEvent, touches: Touch[]): string | null {
  const before = touches
    .filter((t) => t.channel === "affiliate" && (!reply.shopId || !t.shopId || t.shopId === reply.shopId) && key(t) <= key(reply))
    .sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return before.at(-1)?.bd ?? null;
}

/** 计算某站点池 × 达人在 today 的归属状态 */
export function computeState(input: Input, today: string, s: Settings = DEFAULT_SETTINGS): State {
  const conflicts: Conflict[] = [];
  const history: OwnerSpan[] = [];
  const leave = input.lastWorkday ?? {};
  const events = [...input.events].map((e) => ({ ...e, bd: e.bd ?? (e.type === "reply" ? replyBd(e, input.touches) ?? undefined : undefined) }))
    .filter((e) => e.date <= today)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  let owner: string | null = null, anchor: string | null = null, anchorType: string | null = null;
  const repliedBds = new Set<string>(); // 只有首次回复算建联成功，之后的回复不续期（v1.2）
  const until = () => {
    if (!owner || !anchor) return null;
    const p = addDays(anchor, s.protectDays);
    const l = leave[owner];
    return l && l < p ? l : p;
  };
  const close = (end: string, reason: string) => {
    const span = history.at(-1);
    if (span && !span.end) { span.end = end; span.endReason = reason; }
  };
  const expireBefore = (d: string) => {
    const u = until();
    if (owner && u && d > u) {
      close(u, leave[owner] && leave[owner] === u ? "离职" : "保护期到期");
      owner = null; anchor = null; anchorType = null;
    }
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    expireBefore(e.date);
    if (!e.bd) continue;
    if (leave[e.bd] && e.date > leave[e.bd]) continue; // 离职后的动作不计
    const isClaim = CLAIM.has(e.type) && !(e.type === "reply" && repliedBds.has(e.bd));
    if (e.type === "reply") repliedBds.add(e.bd);

    if (!owner) {
      if (!isClaim) continue;
      // 同一天另一个 BD 也建联成功 → 冲突（§5 同日无法判断）
      const rival = events.slice(i + 1).find((x) => x.date === e.date && x.bd && x.bd !== e.bd && CLAIM.has(x.type));
      if (rival?.bd) conflicts.push({ date: e.date, type: "同日无法判断", bds: [e.bd, rival.bd], detail: `${e.bd}「${REASON[e.type]}」与 ${rival.bd}「${REASON[rival.type]}」同日` });
      owner = e.bd; anchor = e.date; anchorType = REASON[e.type];
      history.push({ bd: e.bd, start: e.date, startReason: REASON[e.type] });
      continue;
    }
    if (e.bd === owner) {
      // 续期：发样、回收、申样批准、新的建联成功；普通回复不续期
      if (e.type !== "reply" || isClaim) {
        if (e.type !== "reply" && anchor && e.date >= anchor) { anchor = e.date; anchorType = REASON[e.type]; }
      }
      continue;
    }
    // 保护期内其他 BD 的动作 → 冲突，不改归属（§3.4、§5）
    if (e.type === "reply") continue; // 他人会话里的回复只是事实记录，归属以触达与冲突判定为准
    conflicts.push({
      date: e.date, type: e.type === "sample_approved" ? "申样批准人不一致" : "保护期内他人发样/登记",
      bds: [owner, e.bd], detail: `${e.bd}「${REASON[e.type]}」发生在 ${owner} 保护期内（至 ${until()}）`,
    });
  }
  expireBefore(today); // 截至 today 已过保护期 / 已离职 → 回公共池

  const aff = input.touches.filter((t) => t.channel === "affiliate" && t.date <= today).sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const last = aff.at(-1) ?? null;
  const cooldownUntil = last ? addDays(last.date, s.cooldownDays - 1) : null;
  const protectUntil = until();

  // §8.1 归属标签
  let tag = "";
  const openBds = [...new Set(input.openConflictBds ?? [])];
  if (openBds.length) tag = `${openBds.join("/")}·冲突待判`;
  else if (owner && protectUntil) tag = `${owner}·已归属（至${md(protectUntil)}）`;
  else if (last && addDays(last.date, s.unrepliedTagDays) > today) {
    tag = cooldownUntil && today <= cooldownUntil ? `${last.bd}·未回复（冷却至${md(cooldownUntil)}）` : `${last.bd}·未回复`;
  }
  return {
    owner, protectUntil, anchor, anchorType, lastTouch: last ? { bd: last.bd, date: last.date } : null,
    cooldownUntil, tag, history, conflicts,
  };
}

export type TouchCheck = { allowed: boolean; reason: string };
/** §2 冷却 + §3.4 保护期：某 BD 在 today 能否通过联盟渠道触达该达人 */
export function canTouch(state: State, bd: string, today: string, s: Settings = DEFAULT_SETTINGS): TouchCheck {
  if (state.owner && state.owner !== bd && state.protectUntil && today <= state.protectUntil) {
    return { allowed: false, reason: `保护中：已归属 ${state.owner}（至 ${state.protectUntil}）` };
  }
  if (state.lastTouch && state.cooldownUntil && today <= state.cooldownUntil) {
    return {
      allowed: false,
      reason: `${mdCn(state.lastTouch.date)} ${state.lastTouch.bd} 已触达，${mdCn(addDays(state.lastTouch.date, s.cooldownDays))}起可再发`,
    };
  }
  return { allowed: true, reason: "" };
}
