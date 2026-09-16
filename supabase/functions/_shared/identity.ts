// 达人身份层（纯函数，无 IO）。见 GMV_ATTRIBUTION_V3_PLAN §三。
//
// 【身份识别与 BD 归属是两个独立步骤】——这一层只回答「是不是同一个达人」，**不碰归属**。
// 归属由 creator_attribution_stages（stages.ts）按发布日期查区间得出。
//
// 为什么需要这一层（计划「事实 2」）：
//   · GMV MAX 导出行只有 tt_account_name（通常是昵称），没有用户名；
//   · 飞书建联表每行同时有昵称和用户名；
//   · 两边都有 VID —— VID 是唯一能对上的锚点。
// 现有代码把 normalizeName(account_name) 直接当身份键查归属，于是同一个真人用不同名字
// 出现时会被拆成两个人，各自解析出不同 owner，GMV 被拆给两个人且系统不报冲突。
//
// 做法：把「同一行里共现的昵称+用户名」和「同一个 (站点,VID) 下出现过的所有名字」当成
// 无向边，跑并查集，连通分量 = 一个达人实体。
//
// 站点隔离（§6.5 已确认）：跨站点同 VID 在这套业务里是正常现象（PH/PH2 同国两个店、
// MX-AR/MX-NE/MX-SJ 墨西哥三个店），身份表按站点隔离，跨站点同 VID 自然产生两条互不相干
// 的站点内身份记录，**不合并、不报冲突、不产生待判项**。

import { identityKey } from "./attribution.ts";

export type IdentityType = "NICKNAME" | "USERNAME";
export type EdgeSource = "FEISHU" | "GMV_MAX" | "MANUAL";

/** 身份证据边（对应 creator_identity_edges 一行）。 */
export type IdentityEdge = {
  site: string;
  vid: string;
  feishuNicknameNorm: string;
  feishuUsernameNorm: string;
  gmvNicknameNorm: string;
  observedDate: string | null; // 'YYYY-MM-DD'
  source: EdgeSource;
  status: "ACTIVE" | "REJECTED";
};

/** 身份图里的一个节点：站点内的一个「名字 + 名字类型」。 */
export type IdentityNode = { site: string; type: IdentityType; value: string };

export type IdentityAlias = {
  site: string;
  type: IdentityType;
  normalizedValue: string;
  firstSeenDate: string | null;
  lastSeenDate: string | null;
  source: EdgeSource;
};

export type IdentityComponent = {
  site: string;
  /** 分量内字典序最小的节点键，确定性、可重算，用来找回同一个分量并复用 creator_id */
  signature: string;
  nodeKeys: string[]; // 升序
  aliases: IdentityAlias[];
};

export type IdentityConflict = {
  site: string;
  vid: string;
  kind: "VID_MULTI_USERNAME" | "VID_MULTI_NICKNAME" | "VID_DUAL_SOURCE_MISMATCH";
  detail: unknown;
};

export type IdentityBuild = {
  components: IdentityComponent[];
  conflicts: IdentityConflict[];
  /** 因冲突被判定「不可作身份锚点」的 (站点,VID)，键同 vidKey() */
  unusableVids: string[];
};

// ---------- 键 ----------

export function nodeKey(site: string, type: IdentityType, value: string): string {
  return `${identityKey(site, value)}\u001e${type}`;
}

export function parseNodeKey(key: string): IdentityNode {
  const [scoped, type] = key.split("\u001e");
  const at = scoped.indexOf("\u001f");
  return { site: scoped.slice(0, at), value: scoped.slice(at + 1), type: type as IdentityType };
}

export function vidKey(site: string, vid: string): string {
  return identityKey(site, vid);
}

/**
 * §3.3 GMV MAX 侧的身份观察日期 = **文件月份的下一个月 1 日**（8 月数据 → 2026-09-01）。
 *
 * 理由：导出里的昵称是「导出那一刻」的昵称。用当月 1 日会让同月的飞书记录（比如 8/20 登记）
 * 永远压过 8 月的 GMV MAX 记录，即使后者反映的昵称更新；用下月 1 日刚好覆盖「月结后导出」
 * 这个实际动作，也不用处理 28/30/31 天的差异。
 *
 * 【硬性限制】这个日期**只**用于身份别名的新鲜度排序，
 * 不得出现在 posted_site_date、归属转移日、VID 发布日的任何计算里（测试矩阵第 42 条）。
 */
export function identityObservedDate(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
}

// ---------- 建边 ----------

export type RegistryEdgeRow = {
  country: string;
  vid: string;
  nicknameNorm: string;
  handleNorm: string;
  registerDate: string | null;
  sampleDate: string | null;
  staffName: string;
};

/** 飞书登记行 → 身份边。日期取该行两个动作日期里较早的那个（发样通常早于回收）。 */
export function edgesFromRegistry(rows: RegistryEdgeRow[]): IdentityEdge[] {
  const out: IdentityEdge[] = [];
  for (const r of rows) {
    if (!r.nicknameNorm && !r.handleNorm) continue;
    const dates = [r.sampleDate, r.registerDate].filter(Boolean) as string[];
    out.push({
      site: r.country,
      vid: r.vid,
      feishuNicknameNorm: r.nicknameNorm,
      feishuUsernameNorm: r.handleNorm,
      gmvNicknameNorm: "",
      observedDate: dates.length ? dates.sort()[0] : null,
      source: "FEISHU",
      status: "ACTIVE",
    });
  }
  return out;
}

export type GmvEdgeRow = { country: string; vid: string; accountNameNorm: string; month: string };

/** GMV MAX 导出行 → 身份边（只有昵称，没有用户名）。 */
export function edgesFromGmvRows(rows: GmvEdgeRow[]): IdentityEdge[] {
  const out: IdentityEdge[] = [];
  for (const r of rows) {
    if (!r.accountNameNorm || !r.vid) continue;
    out.push({
      site: r.country,
      vid: r.vid,
      feishuNicknameNorm: "",
      feishuUsernameNorm: "",
      gmvNicknameNorm: r.accountNameNorm,
      observedDate: identityObservedDate(r.month),
      source: "GMV_MAX",
      status: "ACTIVE",
    });
  }
  return out;
}

/**
 * 同一个 (站点, VID) 被登记成了互相矛盾的名字 → 这个 VID 不能当身份锚点。
 *
 * §5.5 / 测试 39：**一个 VID 被两个同事登记，只要昵称、用户名一致，身份照样可以合并** ——
 * 那说明的是归属有争议（另走 VID_DUAL_SOURCE 归因判定），不说明这是两个不同的达人。
 * 测试 35 / 38：名字对不上（同站点同 VID 出现两个不同用户名或两个不同飞书昵称）才是身份冲突，
 * 这个 VID 整个不参与合并，相关名字进 PENDING_IDENTITY 由人判。
 *
 * 注意 GMV MAX 侧的昵称**不参与**这条判定：达人改名后导出里出现新昵称是正常现象（测试 34），
 * 那正是这一层要连上的东西，不是冲突。
 */
export function detectVidConflicts(edges: IdentityEdge[]): { conflicts: IdentityConflict[]; unusable: Set<string> } {
  const byVid = new Map<string, { site: string; vid: string; nicks: Set<string>; users: Set<string> }>();
  for (const e of edges) {
    if (e.status !== "ACTIVE" || !e.vid || e.source !== "FEISHU") continue;
    const k = vidKey(e.site, e.vid);
    const g = byVid.get(k) ?? { site: e.site, vid: e.vid, nicks: new Set<string>(), users: new Set<string>() };
    if (e.feishuNicknameNorm) g.nicks.add(e.feishuNicknameNorm);
    if (e.feishuUsernameNorm) g.users.add(e.feishuUsernameNorm);
    byVid.set(k, g);
  }
  const conflicts: IdentityConflict[] = [];
  const unusable = new Set<string>();
  for (const [k, g] of byVid) {
    if (g.users.size > 1) {
      conflicts.push({ site: g.site, vid: g.vid, kind: "VID_MULTI_USERNAME", detail: { usernames: [...g.users].sort() } });
      unusable.add(k);
    } else if (g.nicks.size > 1) {
      conflicts.push({ site: g.site, vid: g.vid, kind: "VID_MULTI_NICKNAME", detail: { nicknames: [...g.nicks].sort() } });
      unusable.add(k);
    }
  }
  return { conflicts, unusable };
}

// ---------- 并查集 ----------

class UnionFind {
  private parent = new Map<string, string>();
  add(k: string) {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  find(k: string): string {
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // 路径压缩
    let cur = k;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // 小的当根：结果与输入顺序无关，重算得到同一批分量
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
  keys(): string[] {
    return [...this.parent.keys()];
  }
}

/**
 * 从身份边算出连通分量。
 *
 * 两类边：
 *   1. **同行共现**：飞书一行里的昵称与用户名属于同一个人（测试 30，不需要 VID）；
 *   2. **VID 锚定**：同一个 (站点, VID) 下出现过的所有名字属于同一个人（测试 34/37），
 *      但冲突 VID（detectVidConflicts 判定的）不参与。
 *
 * REJECTED 的边整条不参与 —— 这是撤销错误合并的唯一手段（测试 41）。
 */
export function buildIdentityComponents(edges: IdentityEdge[]): IdentityBuild {
  const { conflicts, unusable } = detectVidConflicts(edges);
  const uf = new UnionFind();
  /** (站点,名字,类型) → 观察日期区间与来源 */
  const aliasMeta = new Map<string, IdentityAlias>();

  const touch = (site: string, type: IdentityType, value: string, date: string | null, source: EdgeSource) => {
    const k = nodeKey(site, type, value);
    uf.add(k);
    const prev = aliasMeta.get(k);
    if (!prev) {
      aliasMeta.set(k, { site, type, normalizedValue: value, firstSeenDate: date, lastSeenDate: date, source });
      return k;
    }
    if (date) {
      if (!prev.firstSeenDate || date < prev.firstSeenDate) prev.firstSeenDate = date;
      // 同一个名字被多个来源看到时，last_seen 取最新的那次（§3.6 字段级最新值靠它排序）
      if (!prev.lastSeenDate || date > prev.lastSeenDate) {
        prev.lastSeenDate = date;
        prev.source = source;
      }
    }
    return k;
  };

  const vidMembers = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.status !== "ACTIVE") continue;
    const members: string[] = [];
    if (e.feishuNicknameNorm) members.push(touch(e.site, "NICKNAME", e.feishuNicknameNorm, e.observedDate, e.source));
    if (e.gmvNicknameNorm) members.push(touch(e.site, "NICKNAME", e.gmvNicknameNorm, e.observedDate, e.source));
    if (e.feishuUsernameNorm) members.push(touch(e.site, "USERNAME", e.feishuUsernameNorm, e.observedDate, e.source));
    // 1) 同行共现边
    for (let i = 1; i < members.length; i++) uf.union(members[0], members[i]);
    // 2) VID 锚定边（冲突 VID 不参与）
    if (!e.vid) continue;
    const vk = vidKey(e.site, e.vid);
    if (unusable.has(vk)) continue;
    const set = vidMembers.get(vk) ?? new Set<string>();
    for (const m of members) set.add(m);
    vidMembers.set(vk, set);
  }
  for (const set of vidMembers.values()) {
    const arr = [...set];
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }

  const byRoot = new Map<string, string[]>();
  for (const k of uf.keys()) {
    const r = uf.find(k);
    const arr = byRoot.get(r) ?? [];
    arr.push(k);
    byRoot.set(r, arr);
  }

  const components: IdentityComponent[] = [];
  for (const keys of byRoot.values()) {
    const nodeKeys = keys.sort();
    const site = parseNodeKey(nodeKeys[0]).site;
    components.push({
      site,
      signature: nodeKeys[0], // 字典序最小 = 确定性签名
      nodeKeys,
      aliases: nodeKeys.map((k) => aliasMeta.get(k)!).filter(Boolean),
    });
  }
  components.sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  return { components, conflicts, unusableVids: [...unusable].sort() };
}

// ---------- creator_id 分配（半持久） ----------

export type ExistingEntity = { creatorId: string; site: string; signature: string; createdAt: string; mergedInto: string | null };

export type EntityAssignment = {
  /** 分量签名 → creator_id */
  bySignature: Map<string, string>;
  /** 需要新建的实体（creator_id 由数据库生成，这里只给 site+signature） */
  inserts: Array<{ site: string; signature: string }>;
  /** 存活实体的签名更新（分量并入了新名字，签名跟着变小时） */
  signatureUpdates: Array<{ creatorId: string; signature: string }>;
  /** 被合并掉的一方：creator_id 保留，指向存活方 */
  merges: Array<{ creatorId: string; mergedInto: string }>;
};

/**
 * 把连通分量映射到稳定的 creator_id（§3.2）。
 *
 * creator_id 一经分配**永不重新随机生成**：人工判定、「都不算」规则将来会引用它，
 * 随机重建会让这些引用全部失效。做法是按「已有实体的签名节点是否还在这个分量里」认亲：
 *   · 认到 1 个 → 复用它，必要时更新签名；
 *   · 认到多个 → 两个旧实体被新证据连成一个人：保留**创建更早**的一方，
 *     另一方记 merged_into（不删，外部引用仍能解析）；
 *   · 一个都没认到 → 新建。
 * 分量拆开时（人工把边标 REJECTED，测试 41），含原签名节点的那一半保留原 creator_id，
 * 另一半拿到新 ID —— 「存活方的 creator_id 不变」正是测试 41 的预期。
 */
export function assignCreatorIds(components: IdentityComponent[], existing: ExistingEntity[]): EntityAssignment {
  const alive = existing.filter((e) => !e.mergedInto);
  const bySignature = new Map<string, ExistingEntity>();
  for (const e of alive) bySignature.set(e.signature, e);

  const out: EntityAssignment = {
    bySignature: new Map(),
    inserts: [],
    signatureUpdates: [],
    merges: [],
  };
  const claimed = new Set<string>();

  for (const c of components) {
    const matches = c.nodeKeys
      .map((k) => bySignature.get(k))
      .filter((e): e is ExistingEntity => !!e && e.site === c.site && !claimed.has(e.creatorId));
    if (!matches.length) {
      out.inserts.push({ site: c.site, signature: c.signature });
      continue;
    }
    // 存活方 = 创建最早的一方（同时间取 creator_id 字典序小者，保证确定性）
    const sorted = [...matches].sort((a, b) =>
      a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.creatorId < b.creatorId ? -1 : 1,
    );
    const survivor = sorted[0];
    for (const e of sorted) claimed.add(e.creatorId);
    for (const e of sorted.slice(1)) out.merges.push({ creatorId: e.creatorId, mergedInto: survivor.creatorId });
    if (survivor.signature !== c.signature) out.signatureUpdates.push({ creatorId: survivor.creatorId, signature: c.signature });
    out.bySignature.set(c.signature, survivor.creatorId);
  }
  return out;
}

/**
 * §3.6 字段级最新值：current_nickname / current_username 各自独立取「日期最新的非空值」，
 * **空值不得覆盖非空值**（测试 37）。所以这里按 identity_type 分组、过滤非空、
 * 按 last_seen_date 降序取第一条，绝不做整行覆盖。
 */
export function currentIdentityValues(aliases: IdentityAlias[]): { nickname: string | null; username: string | null } {
  const pick = (type: IdentityType): string | null => {
    const cands = aliases.filter((a) => a.type === type && a.normalizedValue);
    if (!cands.length) return null;
    return [...cands].sort((a, b) => {
      const da = a.lastSeenDate ?? "";
      const db = b.lastSeenDate ?? "";
      if (da !== db) return da > db ? -1 : 1;
      return a.normalizedValue < b.normalizedValue ? -1 : 1; // 同日期取字典序小者，保证确定性
    })[0].normalizedValue;
  };
  return { nickname: pick("NICKNAME"), username: pick("USERNAME") };
}
