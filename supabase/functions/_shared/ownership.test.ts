// 用规则文档里的原例做单测（docs/CREATOR_OWNERSHIP_RULES.md v1.2）
import { addDays, bjDate, canTouch, computeState, replyBd, sitePool } from "./ownership.ts";

function eq(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
const T = (date: string, bd: string, shopId = "S1") => ({ date, bd, channel: "affiliate" as const, shopId });

Deno.test("§1 站点池：PH/PH2/PHL 合并", () => {
  eq(["PH", "PH2", "PHL", "TH"].map(sitePool), ["PH", "PH", "PH", "TH"]);
});

Deno.test("日期工具：北京时间自然日", () => {
  eq(bjDate("2026-09-19T16:30:00Z"), "2026-09-20");
  eq(addDays("2026-01-01", 90), "2026-04-01");
});

Deno.test("§2 冷却：9/20 群发 → 10/3 前任何人（含本人）不能再发，10/4 起可以", () => {
  const st = (d: string) => computeState({ touches: [T("2026-09-20", "林丽洪")], events: [] }, d);
  for (const bd of ["林丽洪", "李汝华"]) {
    eq(canTouch(st("2026-10-03"), bd, "2026-10-03").allowed, false, `${bd} 10/3`);
    eq(canTouch(st("2026-10-04"), bd, "2026-10-04").allowed, true, `${bd} 10/4`);
  }
  eq(canTouch(st("2026-09-25"), "李汝华", "2026-09-25").reason, "9月20日 林丽洪 已触达，10月4日起可再发");
  eq(st("2026-09-25").tag, "林丽洪·未回复（冷却至10/3）");
  eq(st("2026-10-10").tag, "林丽洪·未回复");
});

Deno.test("§3.1 + §3.5 公共池谁先建联成功归谁；回复归最近一次触达的 BD", () => {
  const input = {
    touches: [T("2026-09-20", "林丽洪"), T("2026-10-05", "李汝华")],
    events: [{ date: "2026-10-08", type: "reply" as const, shopId: "S1" }],
  };
  eq(replyBd(input.events[0], input.touches), "李汝华");
  const s = computeState(input, "2026-10-09");
  eq(s.owner, "李汝华");
  eq(s.protectUntil, "2027-01-06");
  eq(s.tag, "李汝华·已归属（至1/6）");
  eq(canTouch(s, "林丽洪", "2026-10-25").allowed, false, "保护期内他人不能触达");
});

Deno.test("§3.3 保护期含第 90 天：1/1 发样（申样批准）→ 4/1 仍保护，4/2 回公共池", () => {
  const input = { touches: [], events: [{ date: "2026-01-01", type: "sample_approved" as const, bd: "林丽洪" }] };
  eq(computeState(input, "2026-04-01").owner, "林丽洪");
  const after = computeState(input, "2026-04-02");
  eq(after.owner, null);
  eq(after.tag, "");
  eq(after.history[0].endReason, "保护期到期");
});

Deno.test("§3.3 v1.2：之后只聊天不续期；发样/回收续期", () => {
  const base = { touches: [T("2025-12-20", "林丽洪")], events: [
    { date: "2026-01-01", type: "sample_approved" as const, bd: "林丽洪" },
    { date: "2026-02-10", type: "reply" as const, shopId: "S1" },
    { date: "2026-03-15", type: "reply" as const, shopId: "S1" },
  ] };
  eq(computeState(base, "2026-04-01").protectUntil, "2026-04-01", "回复不续期");
  const renewed = { ...base, events: [...base.events, { date: "2026-03-01", type: "vid_recovered" as const, bd: "林丽洪" }] };
  eq(computeState(renewed, "2026-04-02").protectUntil, "2026-05-30", "回收续期");
});

Deno.test("§3.4/§5 保护期内他人发样登记 → 冲突，不改归属", () => {
  const s = computeState({ touches: [], events: [
    { date: "2026-03-01", type: "sample_approved", bd: "林丽洪" },
    { date: "2026-03-10", type: "sample_shipped", bd: "林乐欣" },
  ] }, "2026-03-11");
  eq(s.owner, "林丽洪");
  eq(s.conflicts.map((c) => c.type), ["保护期内他人发样/登记"]);
});

Deno.test("§5 同日两人建联成功 → 冲突；§8.1 冲突标签列出所有 BD", () => {
  const s = computeState({ touches: [], events: [
    { date: "2026-03-01", type: "sample_approved", bd: "林丽洪" },
    { date: "2026-03-01", type: "vid_recovered", bd: "林乐欣" },
  ], openConflictBds: ["林丽洪", "林乐欣"] }, "2026-03-02");
  eq(s.conflicts[0].type, "同日无法判断");
  eq(s.tag, "林丽洪/林乐欣·冲突待判");
});

Deno.test("§4 离职：最后工作日 L 当天仍归属，L+1 进公共池", () => {
  const input = { touches: [], events: [{ date: "2026-03-01", type: "sample_approved" as const, bd: "阿南" }], lastWorkday: { "阿南": "2026-03-20" } };
  eq(computeState(input, "2026-03-20").owner, "阿南");
  const s = computeState(input, "2026-03-21");
  eq(s.owner, null);
  eq(s.history[0].endReason, "离职");
});

Deno.test("§8.1 未回复标签在最近一次触达满 90 天后消失", () => {
  const input = { touches: [T("2026-01-01", "李汝华")], events: [] };
  eq(computeState(input, "2026-03-31").tag, "李汝华·未回复");
  eq(computeState(input, "2026-04-01").tag, "");
});
