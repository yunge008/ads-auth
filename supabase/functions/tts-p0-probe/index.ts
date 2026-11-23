// 联盟达人外联 P0 实测工具（仅管理员）。在「API测试」页粘贴 JSON 调用，例：
//   {"function":"tts-p0-probe","body":{"action":"shops"}}
//
// action：
//   apps                                        列出应用（tts_apps，不含 app_secret）+ 各应用已授权店铺数
//   save_app {code, name?, app_key?, app_secret?, service_id?}  新增/修改应用；app_secret 留空 = 不改
//   auth_url {app?}                             返回该应用的店铺授权链接（service_id 取 tts_apps；default 回落 secret TTS_SERVICE_ID）
//   exchange {auth_code, app?}                  auth_code → token → Get Authorized Shops → 写 tts_shops（app 默认 default；返回不含 token）
//   shops                                       列出已授权店铺（不含 token）
//   refresh  {shop_id}                          用该店铺所属应用 + refresh_token 换新 token
//   refresh_due {within_hours?=48}              刷新 access 将在 N 小时内到期的全部授权（pg_cron 每天调用；cron 身份只放行这一个 action）
//   read     {shop_id, handles:[...]}           只读实测：名额 / 筛选项 / 逐个 handle 解析 / 资格检查 / 外联记录 / 会话列表 / 计划列表
//   write    {shop_id, handles:[...], product_ids:[...], commission_pct, ad_commission_pct?, contact, message_text, tc_message?, send_card?, confirm:"SEND"}
//            （也兼容单个 handle / product_id）
//                                               真实写入：建 1 个定向计划（多达人×多商品） → 查详情 → 生成邀请链接 → 取/建会话 → 发私信（+可选计划卡片）
//                                               会消耗 1 个本周外联名额，并真的给达人发消息
//   add_to_tc {shop_id, tc_id, handles?, product_ids?, commission_pct?, ad_commission_pct?, message_text?, send_card?, confirm:"SEND"}
//                                               已有定向计划增发达人/商品：读详情 → 合并 → 全量 PUT → 回读校验老达人未丢 → 只给新达人发消息
//   name_probe {shop_id, tc_id, names?, confirm:"SEND"}  已有计划逐个改名测名称上限，最后改回原名（不新建、不发消息）
//   check2   {shop_id, tc_id?, product_ids?}     只读：最新未读/收件箱计数/会话分页/样品申请/联盟订单/计划内推广明细/冲突检查
//   recon    {shop_id, kind:"orders", date:"YYYY-MM-DD"} 按店铺本地日拉全部订单（自动翻页，紧凑行）
//            {shop_id, kind:"statement", statement_id}   按结算单拉逐单结算交易（自动翻页，紧凑行）
//   raw      {shop_id, method, path, query?, body?}  单接口调用（补测用），path 限 /affiliate_seller/ /authorization/
//            /product/ /analytics/ /order/ /finance/ /promotion/
//
// 读写闸门（_shared/tts.ts ttsAccessCheck，2026-11-16 负责人规定）：所有 TTS 调用默认只读；
// 写接口目前只放行「定向计划新建 / 修改」。生成邀请链接、建会话、发私信、标记已读、冲突处理等写接口
// 现已被拦截，需负责人逐条确认后才能加入 TTS_WRITE_ALLOW。write / add_to_tc 中这些步骤会返回拦截信息。
//
// 与 `_shared/tiktok.ts`（Business API）完全独立；只读写 tts_shops 一张表。
import { admin, requireAdmin } from "../_shared/auth.ts";
import { cronAuthed } from "../_shared/cron.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import {
  normalizeHandle, pctToRate, type TtsApp, ttsApp, ttsAppCacheClear, ttsCall, TTS_DEFAULT_APP, type TtsResult, ttsExchangeCode, ttsRefreshToken, type TtsToken,
} from "../_shared/tts.ts";

type Shop = {
  shop_id: string;
  shop_cipher: string;
  shop_name: string | null;
  region: string | null;
  seller_type: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string[];
  contact_info: Record<string, string> | null;
  app_code?: string | null;
};

const PUBLIC_COLS =
  "shop_id,shop_code,shop_name,region,seller_type,seller_name,seller_base_region,user_type,access_expires_at,refresh_expires_at,scopes,contact_info,status,authorized_by,updated_at";
// 20261123120000_tts_multi_app.sql 新增列；migration 未跑时回落 PUBLIC_COLS
const PUBLIC_COLS_V2 = `${PUBLIC_COLS},app_code,last_refresh_at,last_refresh_error`;
const APP_CODE_RE = /^[a-z0-9-]{1,32}$/;

function appCode(v: unknown): string {
  const c = String(v ?? "").trim().toLowerCase() || TTS_DEFAULT_APP;
  if (!APP_CODE_RE.test(c)) bad(`应用代号不合法：${c}（只能小写字母/数字/-）`);
  return c;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bad(msg: string): never {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  throw e;
}

const tsToIso = (s: number | undefined) => (s ? new Date(s * 1000).toISOString() : null);

async function loadShop(shopId: unknown): Promise<Shop> {
  const id = String(shopId ?? "").trim();
  if (!id) bad("shop_id 必填（先用 action=shops 查看）");
  const { data, error } = await admin().from("tts_shops").select("*").eq("shop_id", id).maybeSingle();
  if (error) throw error;
  if (!data) bad(`tts_shops 里没有 shop_id=${id}，请先 action=exchange 授权`);
  return data as Shop;
}

/** 精简一步的返回：保留 code/message/request_id，data 原样（调用方自行裁剪大字段）。 */
function step(name: string, r: TtsResult, data?: unknown) {
  return {
    step: name,
    ok: r.code === 0,
    path: `${r.method} ${r.path}`,
    http_status: r.http_status,
    code: r.code,
    message: r.message,
    request_id: r.request_id,
    attempts: r.attempts,
    data: data === undefined ? r.data : data,
  };
}

async function saveToken(tok: TtsToken, operator: string, app: TtsApp) {
  const shopsRes = await ttsCall<{ shops?: Array<Record<string, string>> }>({
    method: "GET",
    path: "/authorization/202309/shops",
    accessToken: tok.access_token,
    app,
  });
  if (shopsRes.code !== 0) {
    return { saved: [], get_authorized_shops: step("get_authorized_shops", shopsRes) };
  }
  const rows = (shopsRes.data?.shops ?? []).map((s) => ({
    shop_id: s.id,
    shop_cipher: s.cipher,
    shop_code: s.code ?? null,
    shop_name: s.name ?? null,
    region: s.region ?? null,
    seller_type: s.seller_type ?? null,
    seller_name: tok.seller_name ?? null,
    seller_base_region: tok.seller_base_region ?? null,
    authorizer_open_id: tok.open_id ?? null,
    user_type: tok.user_type ?? null,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    access_expires_at: tsToIso(tok.access_token_expire_in),
    refresh_expires_at: tsToIso(tok.refresh_token_expire_in),
    scopes: tok.granted_scopes ?? [],
    status: "ACTIVE",
    authorized_by: operator,
    updated_at: new Date().toISOString(),
    app_code: app.code,
    last_refresh_at: new Date().toISOString(),
    last_refresh_error: null as string | null,
  }));
  if (rows.length) {
    let { error } = await admin().from("tts_shops").upsert(rows, { onConflict: "shop_id" });
    if (error && app.code === TTS_DEFAULT_APP && /app_code|last_refresh/.test(error.message)) {
      // migration 未跑：只写旧列（仅 default 应用可这样兜底，其他应用必须记录 app_code 否则后续签名会用错应用）
      const legacy = rows.map(({ app_code: _a, last_refresh_at: _b, last_refresh_error: _c, ...r }) => r);
      ({ error } = await admin().from("tts_shops").upsert(legacy, { onConflict: "shop_id" }));
    }
    if (error) throw error;
  }
  return {
    saved: rows.map((r) => ({ shop_id: r.shop_id, shop_name: r.shop_name, region: r.region, seller_type: r.seller_type })),
    seller_name: tok.seller_name,
    seller_base_region: tok.seller_base_region,
    user_type: tok.user_type,
    granted_scopes: tok.granted_scopes,
    access_expires_at: tsToIso(tok.access_token_expire_in),
    refresh_expires_at: tsToIso(tok.refresh_token_expire_in),
    app: app.code,
  };
}

async function listShops() {
  const r = await admin().from("tts_shops").select(PUBLIC_COLS_V2).order("region");
  if (!r.error) return r.data;
  const legacy = await admin().from("tts_shops").select(PUBLIC_COLS).order("region");
  if (legacy.error) throw legacy.error;
  return legacy.data;
}

async function listApps() {
  const { data, error } = await admin().from("tts_apps").select("code,name,app_key,app_secret,service_id,updated_by,updated_at").order("created_at");
  if (error) bad(`读取 tts_apps 失败（先在 SQL Editor 执行 20261123120000_tts_multi_app.sql）：${error.message}`);
  const { data: shops } = await admin().from("tts_shops").select("app_code");
  const count = new Map<string, number>();
  for (const s of (shops ?? []) as Array<{ app_code?: string }>) {
    const c = s.app_code ?? TTS_DEFAULT_APP;
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  const envDefault = !!(Deno.env.get("TTS_APP_KEY") && Deno.env.get("TTS_APP_SECRET"));
  return (data ?? []).map((a) => {
    const fromEnv = a.code === TTS_DEFAULT_APP && !a.app_key;
    return {
      code: a.code,
      name: a.name,
      app_key: fromEnv ? (Deno.env.get("TTS_APP_KEY") ?? "") : a.app_key,
      has_secret: fromEnv ? envDefault : !!a.app_secret,
      service_id: a.service_id || (a.code === TTS_DEFAULT_APP ? (Deno.env.get("TTS_SERVICE_ID") ?? "") : ""),
      creds_source: fromEnv ? "secrets" : "table",
      updated_by: a.updated_by,
      updated_at: a.updated_at,
      shop_count: count.get(a.code) ?? 0,
    };
  });
}

async function saveApp(b: Record<string, unknown>, operator: string) {
  const code = appCode(b.code);
  const patch: Record<string, unknown> = { code, updated_by: operator, updated_at: new Date().toISOString() };
  for (const k of ["name", "app_key", "app_secret", "service_id"] as const) {
    const v = b[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (k === "app_secret" && !t) continue; // 留空 = 不改
    patch[k] = t;
  }
  const { data: cur } = await admin().from("tts_apps").select("code,name").eq("code", code).maybeSingle();
  if (!cur && !patch.name) patch.name = code.toUpperCase();
  const { error } = await admin().from("tts_apps").upsert(patch, { onConflict: "code" });
  if (error) throw error;
  ttsAppCacheClear();
  return { ok: true, apps: await listApps() };
}

/** 刷新 access 将在 withinHours 内到期的授权。同一次授权（同应用 + 同 refresh_token）的多个店铺只刷一次。 */
async function refreshDue(withinHours: number, operator: string) {
  const { data, error } = await admin().from("tts_shops")
    .select("shop_id,shop_name,region,app_code,refresh_token,access_expires_at,refresh_expires_at");
  if (error) throw error;
  const deadline = Date.now() + withinHours * 3600_000;
  type Row = { shop_id: string; shop_name: string | null; region: string | null; app_code: string | null; refresh_token: string; access_expires_at: string | null; refresh_expires_at: string | null };
  const groups = new Map<string, Row[]>();
  for (const r of (data ?? []) as Row[]) {
    if (r.access_expires_at && Date.parse(r.access_expires_at) > deadline) continue;
    const k = `${r.app_code ?? TTS_DEFAULT_APP}\u0000${r.refresh_token}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const results: Array<{ app: string; shops: string[]; ok: boolean; message: string; access_expires_at?: string | null }> = [];
  for (const rows of groups.values()) {
    const code = rows[0].app_code ?? TTS_DEFAULT_APP;
    const names = rows.map((r) => `${r.region ?? ""} ${r.shop_name ?? r.shop_id}`.trim());
    const ids = rows.map((r) => r.shop_id);
    const markErr = (msg: string) =>
      admin().from("tts_shops").update({ last_refresh_at: new Date().toISOString(), last_refresh_error: msg.slice(0, 500) }).in("shop_id", ids);
    const rExp = rows[0].refresh_expires_at;
    if (rExp && Date.parse(rExp) < Date.now()) {
      const msg = "refresh_token 已过期，需重新授权";
      await markErr(msg);
      results.push({ app: code, shops: names, ok: false, message: msg });
      continue;
    }
    try {
      const app = await ttsApp(code);
      const saved = await saveToken(await ttsRefreshToken(rows[0].refresh_token, app), operator, app);
      const got = new Set(saved.saved.map((s) => s.shop_id));
      const missing = ids.filter((id) => !got.has(id));
      if (missing.length) {
        await admin().from("tts_shops").update({ last_refresh_error: "刷新后不在授权店铺列表中（可能已取消授权）" }).in("shop_id", missing);
      }
      const ok = got.size > 0 && !missing.length;
      results.push({
        app: code, shops: names, ok,
        message: ok ? "ok" : (got.size ? `${missing.length} 个店铺不在授权列表` : `获取店铺失败：${saved.get_authorized_shops?.message ?? ""}`),
        access_expires_at: saved.access_expires_at,
      });
    } catch (e) {
      const msg = (e as Error).message;
      await markErr(msg);
      results.push({ app: code, shops: names, ok: false, message: msg });
    }
  }
  return { checked: (data ?? []).length, groups: results.length, failed: results.filter((r) => !r.ok).length, results };
}

type Creator = { username?: string; nickname?: string; creator_open_id?: string; follower_count?: number; selection_region?: string };

async function resolveHandle(shop: Shop, handle: string) {
  const h = normalizeHandle(handle);
  const r = await ttsCall<{ creators?: Creator[] }>({
    method: "POST",
    path: "/affiliate_seller/202608/marketplace_creators/search",
    accessToken: shop.access_token,
    shopCipher: shop.shop_cipher,
    query: { page_size: 20 },
    body: { keyword: h, data_groups: ["BASIC_CREATOR_INFORMATION"] },
  });
  await new Promise((r) => setTimeout(r, 700)); // 搜达人接口限流较严（P0 实测 T3），单独再降速到约 1 次/秒
  const creators = r.data?.creators ?? [];
  const exact = creators.filter((c) => normalizeHandle(c.username ?? "") === h);
  const status = r.code !== 0 ? "ERROR" : exact.length === 1 ? "OK" : exact.length > 1 ? "AMBIGUOUS" : "NOT_FOUND";
  return {
    handle: h,
    status,
    open_id: exact.length === 1 ? exact[0].creator_open_id ?? null : null,
    matched: exact[0] ?? null,
    candidates_top5: creators.slice(0, 5).map((c) => ({
      username: c.username,
      nickname: c.nickname,
      follower_count: c.follower_count,
      selection_region: c.selection_region,
      creator_open_id: c.creator_open_id,
    })),
    api: step("search_creator", r, null),
  };
}

async function actionRead(shop: Shop, handles: string[]) {
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const out: Record<string, unknown> = { shop_id: shop.shop_id, region: shop.region, seller_type: shop.seller_type };

  out.quota = step("weekly_quota", await ttsCall({ ...T, method: "GET", path: "/affiliate_seller/202607/creator_outreach/quota" }));
  out.search_filters = step(
    "search_filters",
    await ttsCall({ ...T, method: "POST", path: "/affiliate_seller/202608/marketplace_creators/search/filter", body: {} }),
  );

  const resolved = [];
  for (const h of handles.slice(0, 30)) resolved.push(await resolveHandle(shop, h));
  const ok = resolved.filter((x) => x.status === "OK").length;
  out.handle_resolution = {
    total: resolved.length,
    ok,
    not_found: resolved.filter((x) => x.status === "NOT_FOUND").length,
    ambiguous: resolved.filter((x) => x.status === "AMBIGUOUS").length,
    error: resolved.filter((x) => x.status === "ERROR").length,
    success_rate: resolved.length ? `${Math.round((ok / resolved.length) * 1000) / 10}%` : "n/a",
    rows: resolved,
  };

  const openIds = resolved.map((x) => x.open_id).filter((x): x is string => !!x);
  if (openIds.length) {
    out.eligibility = step(
      "eligibility_check",
      await ttsCall({
        ...T,
        method: "POST",
        path: "/affiliate_seller/202610/creator_outreach/eligibility/check",
        body: { creator_infos: openIds.slice(0, 100).map((id) => ({ creator_open_id: id })) },
      }),
    );
  } else {
    out.eligibility = { step: "eligibility_check", skipped: "没有解析成功的 open_id" };
  }

  out.outreach_records = step(
    "weekly_outreach_records",
    await ttsCall({
      ...T,
      method: "POST",
      path: "/affiliate_seller/202608/creator_outreach/records/query",
      body: { page_index: 1, page_size: 20 },
    }),
  );
  out.conversations = step(
    "conversation_list",
    await ttsCall({
      ...T,
      method: "GET",
      path: "/affiliate_seller/202412/conversations",
      query: { page_size: 10, only_need_conversation_id: false },
    }),
  );
  out.target_collaborations = step(
    "search_target_collaborations",
    await ttsCall({
      ...T,
      method: "POST",
      path: "/affiliate_seller/202508/target_collaborations/search",
      query: { page_size: 20 },
      body: { collaboration_status: "ONGOING" },
    }),
  );
  return out;
}

function strList(one: unknown, many: unknown): string[] {
  const arr = Array.isArray(many) ? many : one !== undefined && one !== null && one !== "" ? [one] : [];
  return [...new Set(arr.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

async function actionWrite(shop: Shop, b: Record<string, unknown>, operator: string) {
  if (b.confirm !== "SEND") bad('写入会真实建计划、消耗名额、给达人发消息。确认请在 body 里加 "confirm":"SEND"');
  const productIds = strList(b.product_id, b.product_ids);
  const handles = strList(b.handle, b.handles);
  const pct = Number(b.commission_pct);
  const adPct = b.ad_commission_pct === undefined || b.ad_commission_pct === null || b.ad_commission_pct === ""
    ? null
    : Number(b.ad_commission_pct);
  const text = String(b.message_text ?? "").trim();
  const tcMessage = String(b.tc_message ?? "").trim();
  if (!productIds.length || productIds.length > 100) bad("product_id / product_ids 必填，最多 100 个");
  if (!handles.length || handles.length > 50) bad("handle / handles 必填，最多 50 个");
  if (!(pct >= 1 && pct <= 80)) bad("commission_pct 需在 1–80 之间（单位：%）");
  if (adPct !== null && !(adPct >= 0 && adPct <= 80)) bad("ad_commission_pct 需在 0–80 之间（单位：%）");
  if (!text) bad("message_text 必填（私信正文，{link} 会被替换成计划邀请链接）");
  const contact = (b.contact as Record<string, string> | undefined) ?? shop.contact_info ?? null;
  if (!contact || !Object.values(contact).some((v) => String(v ?? "").trim())) {
    bad("contact 必填：至少一个 email / phone_number / whatsapp / telegram / line");
  }

  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const steps: unknown[] = [];
  const creators: Array<{ handle: string; open_id: string }> = [];
  for (const h of handles) {
    const res = await resolveHandle(shop, h);
    steps.push({ ...res, candidates_top5: undefined, matched: undefined });
    if (res.open_id) creators.push({ handle: res.handle, open_id: res.open_id });
  }
  if (!creators.length) return { stopped_at: "resolve_handle", steps };
  const openIds = creators.map((c) => c.open_id);

  steps.push(step("quota_before", await ttsCall({ ...T, method: "GET", path: "/affiliate_seller/202607/creator_outreach/quota" })));
  steps.push(step(
    "eligibility_check",
    await ttsCall({
      ...T,
      method: "POST",
      path: "/affiliate_seller/202610/creator_outreach/eligibility/check",
      body: { creator_infos: openIds.map((id) => ({ creator_open_id: id })) },
    }),
  ));

  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const customName = String(b.tc_name ?? "").trim();
  const name = customName || `P0-${shop.region ?? ""}-${ymd}-${operator}`;
  const endTime = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // 默认约 2 个月（R10）
  const products = productIds.map((id) => {
    const p: Record<string, unknown> = { id, target_commission_rate: pctToRate(pct) };
    if (adPct !== null) p.shop_ads_commission_rate = pctToRate(adPct);
    return p;
  });
  const createBody: Record<string, unknown> = {
    name,
    end_time: String(endTime),
    products,
    creator_user_open_ids: openIds,
    seller_contact_info: contact,
    free_sample_rule: { has_free_sample: true, is_sample_approval_exempt: false }, // 允许申样、人工审核（R10）
  };
  if (tcMessage) createBody.message = tcMessage;
  type CreateResp = {
    target_collaboration?: { id?: string };
    target_collaboration_conflicts?: unknown[];
    invalid_open_id_list?: string[];
    invalid_product_id_list?: string[];
  };
  const tryCreate = async (label: string, body: Record<string, unknown>) => {
    const r = await ttsCall<CreateResp>({
      ...T,
      method: "POST",
      path: "/affiliate_seller/202508/target_collaborations",
      body,
      write: true,
    });
    steps.push({ ...step(`create_target_collaboration${label}`, r), request_body: body });
    return r;
  };
  // 98001004 = 参数校验不通过（平台已拒绝、未创建），可以安全地换参数再试，用来定位是 name 还是 message 不合规。
  let created = await tryCreate("", createBody);
  if (created.code === 98001004 && createBody.message) {
    const { message: _m, ...noMsg } = createBody;
    created = await tryCreate("_retry_without_message", noMsg);
    if (created.code === 98001004) {
      created = await tryCreate("_retry_short_name_without_message", { ...noMsg, name: `P0-${shop.region ?? ""}-${ymd.slice(4)}` });
    }
  } else if (created.code === 98001004) {
    created = await tryCreate("_retry_short_name", { ...createBody, name: `P0-${shop.region ?? ""}-${ymd.slice(4)}` });
  }
  const tcId = created.data?.target_collaboration?.id;
  if (created.code !== 0 || !tcId) return { stopped_at: "create_target_collaboration", steps };

  steps.push(step(
    "target_collaboration_detail",
    await ttsCall({ ...T, method: "GET", path: `/affiliate_seller/202508/target_collaborations/${tcId}` }),
  ));
  const link = await ttsCall<{ link?: string }>({
    ...T,
    method: "POST",
    path: `/affiliate_seller/202509/target_collaboration/${tcId}/link`,
    body: {},
    write: true,
  });
  steps.push(step("generate_link", link));
  const msgText = text.replace("{link}", link.data?.link ?? "");

  const perCreator: unknown[] = [];
  for (const c of creators) {
    const cs: unknown[] = [];
    const conv = await ttsCall<{ conversation_id?: string; is_new?: boolean }>({
      ...T,
      method: "POST",
      path: "/affiliate_seller/202508/conversations",
      body: { creator_open_id: c.open_id, only_need_conversation_id: false },
      write: true,
    });
    cs.push(step("get_or_create_conversation", conv));
    const convId = conv.data?.conversation_id;
    if (conv.code === 0 && convId) {
      cs.push(step(
        "send_text",
        await ttsCall({
          ...T,
          method: "POST",
          path: `/affiliate_seller/202412/conversations/${convId}/messages`,
          body: { msg_type: "TEXT", content: JSON.stringify({ content: msgText }) },
          write: true,
        }),
      ));
      if (b.send_card === true) {
        cs.push(step(
          "send_target_collaboration_card",
          await ttsCall({
            ...T,
            method: "POST",
            path: `/affiliate_seller/202412/conversations/${convId}/messages`,
            body: { msg_type: "TARGET_COLLABORATION_CARD", content: JSON.stringify({ target_collaboration_id: tcId }) },
            write: true,
          }),
        ));
      }
      cs.push(step(
        "conversation_messages",
        await ttsCall({
          ...T,
          method: "GET",
          path: `/affiliate_seller/202412/conversation/${convId}/messages`,
          query: { page_size: 5 },
        }),
      ));
    }
    perCreator.push({ handle: c.handle, conversation_id: convId ?? null, steps: cs });
  }
  steps.push(step("quota_after", await ttsCall({ ...T, method: "GET", path: "/affiliate_seller/202607/creator_outreach/quota" })));
  return { target_collaboration_id: tcId, invite_link: link.data?.link ?? null, creators: perCreator, steps };
}

type TcDetail = {
  name?: string;
  end_time?: number;
  creator_invited_count?: number;
  product_count?: number;
  seller_contact_info?: Record<string, string>;
  free_sample_rule?: { has_free_sample?: boolean; is_sample_approval_exempt?: boolean };
  creators?: Array<{ creator_open_id?: string; username?: string }>;
  products?: Array<{ id?: string; commission?: { rate?: number; shop_ads_commission_rate?: number } }>;
};

/**
 * 已有定向计划增发达人 / 商品（N1 预研）。
 * Update 接口是「全量覆盖」：creator_user_open_ids / products 漏传 = 移除（响应里有 remove_* 字段）。
 * 所以必须先读详情、合并后整体提交；详情里的达人/商品数与计数字段对不上时直接中止，宁可不改也不误删。
 * 字段名与 Create 不同：commission_rate / target_ad_commission_rate（Create 是 target_commission_rate / shop_ads_commission_rate）。
 */
async function actionAddToTc(shop: Shop, b: Record<string, unknown>) {
  if (b.confirm !== "SEND") bad('会真实修改定向计划（并给新达人发消息）。确认请在 body 里加 "confirm":"SEND"');
  const tcId = String(b.tc_id ?? "").trim();
  if (!tcId) bad("tc_id 必填");
  const handles = strList(b.handle, b.handles);
  const productIds = strList(b.product_id, b.product_ids);
  if (!handles.length && !productIds.length) bad("handles / product_ids 至少给一个");
  const pct = Number(b.commission_pct);
  const adPct = b.ad_commission_pct === undefined || b.ad_commission_pct === null || b.ad_commission_pct === ""
    ? null
    : Number(b.ad_commission_pct);
  if (productIds.length && !(pct >= 1 && pct <= 80)) bad("新增商品时 commission_pct 必填，1–80（%）");
  const text = String(b.message_text ?? "").trim();

  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const steps: unknown[] = [];
  const getDetail = async (label: string) => {
    const r = await ttsCall<{ target_collaboration?: TcDetail }>({
      ...T,
      method: "GET",
      path: `/affiliate_seller/202508/target_collaborations/${tcId}`,
    });
    steps.push(step(label, r, {
      creators: (r.data?.target_collaboration?.creators ?? []).map((c) => c.username),
      products: (r.data?.target_collaboration?.products ?? []).map((p) => ({ id: p.id, commission: p.commission })),
      creator_invited_count: r.data?.target_collaboration?.creator_invited_count,
      product_count: r.data?.target_collaboration?.product_count,
      end_time: r.data?.target_collaboration?.end_time,
    }));
    return r;
  };
  const before = await getDetail("detail_before");
  const d = before.data?.target_collaboration;
  if (before.code !== 0 || !d) return { stopped_at: "detail_before", steps };
  const oldCreators = (d.creators ?? []).map((c) => c.creator_open_id).filter((x): x is string => !!x);
  const oldProducts = d.products ?? [];
  if (d.creator_invited_count !== undefined && d.creator_invited_count !== oldCreators.length) {
    return { stopped_at: "safety_check", reason: `详情只返回 ${oldCreators.length} 个达人，计数是 ${d.creator_invited_count}，为防误删中止`, steps };
  }
  if (d.product_count !== undefined && d.product_count !== oldProducts.length) {
    return { stopped_at: "safety_check", reason: `详情只返回 ${oldProducts.length} 个商品，计数是 ${d.product_count}，为防误删中止`, steps };
  }

  const newCreators: Array<{ handle: string; open_id: string }> = [];
  for (const h of handles) {
    const res = await resolveHandle(shop, h);
    steps.push({ ...res, candidates_top5: undefined, matched: undefined });
    if (res.open_id && !oldCreators.includes(res.open_id)) newCreators.push({ handle: res.handle, open_id: res.open_id });
  }
  const allCreators = [...oldCreators, ...newCreators.map((c) => c.open_id)];
  if (allCreators.length > 50) bad(`合并后 ${allCreators.length} 个达人，超过单计划 50 人上限`);

  const products: Array<Record<string, unknown>> = oldProducts.map((p) => {
    const o: Record<string, unknown> = { id: p.id, commission_rate: p.commission?.rate };
    if (p.commission?.shop_ads_commission_rate !== undefined) o.target_ad_commission_rate = p.commission.shop_ads_commission_rate;
    return o;
  });
  for (const id of productIds) {
    if (products.some((p) => p.id === id)) continue;
    const o: Record<string, unknown> = { id, commission_rate: pctToRate(pct) };
    if (adPct !== null) o.target_ad_commission_rate = pctToRate(adPct);
    products.push(o);
  }
  if (products.length > 100) bad(`合并后 ${products.length} 个商品，超过 100 上限`);

  const updateBody = {
    name: d.name,
    end_time: String(d.end_time),
    products,
    creator_user_open_ids: allCreators,
    seller_contact_info: d.seller_contact_info ?? {},
    free_sample_rule: {
      has_free_sample: d.free_sample_rule?.has_free_sample ?? true,
      is_sample_approval_exempt: d.free_sample_rule?.is_sample_approval_exempt ?? false,
    },
  };
  const upd = await ttsCall({
    ...T,
    method: "PUT",
    path: `/affiliate_seller/202508/target_collaborations/${tcId}`,
    body: updateBody,
    write: true,
  });
  steps.push({ ...step("update_target_collaboration", upd), request_body: updateBody });
  if (upd.code !== 0) return { stopped_at: "update_target_collaboration", steps };

  const after = await getDetail("detail_after");
  const afterIds = (after.data?.target_collaboration?.creators ?? []).map((c) => c.creator_open_id);
  const verify = {
    old_creators_kept: oldCreators.every((id) => afterIds.includes(id)),
    new_creators_added: newCreators.every((c) => afterIds.includes(c.open_id)),
    product_count_after: after.data?.target_collaboration?.product_count,
  };

  const perCreator: unknown[] = [];
  if (text) {
    const link = await ttsCall<{ link?: string }>({
      ...T,
      method: "POST",
      path: `/affiliate_seller/202509/target_collaboration/${tcId}/link`,
      body: {},
      write: true,
    });
    steps.push(step("generate_link", link));
    const msgText = text.replace("{link}", link.data?.link ?? "");
    for (const c of newCreators) {
      const cs: unknown[] = [];
      const conv = await ttsCall<{ conversation_id?: string }>({
        ...T,
        method: "POST",
        path: "/affiliate_seller/202508/conversations",
        body: { creator_open_id: c.open_id, only_need_conversation_id: true },
        write: true,
      });
      cs.push(step("get_or_create_conversation", conv));
      const convId = conv.data?.conversation_id;
      if (conv.code === 0 && convId) {
        cs.push(step("send_text", await ttsCall({
          ...T,
          method: "POST",
          path: `/affiliate_seller/202412/conversations/${convId}/messages`,
          body: { msg_type: "TEXT", content: JSON.stringify({ content: msgText }) },
          write: true,
        })));
        if (b.send_card === true) {
          cs.push(step("send_target_collaboration_card", await ttsCall({
            ...T,
            method: "POST",
            path: `/affiliate_seller/202412/conversations/${convId}/messages`,
            body: { msg_type: "TARGET_COLLABORATION_CARD", content: JSON.stringify({ target_collaboration_id: tcId }) },
            write: true,
          })));
        }
      }
      perCreator.push({ handle: c.handle, conversation_id: convId ?? null, steps: cs });
    }
  }
  return { tc_id: tcId, added_creators: newCreators.map((c) => c.handle), verify, messages: perCreator, steps };
}

/** 读计划详情并组装一份「原样不变」的 Update 全量请求体；计数对不上返回 null（防误删）。 */
async function loadTcForUpdate(shop: Shop, tcId: string) {
  const r = await ttsCall<{ target_collaboration?: TcDetail }>({
    accessToken: shop.access_token,
    shopCipher: shop.shop_cipher,
    method: "GET",
    path: `/affiliate_seller/202508/target_collaborations/${tcId}`,
  });
  const d = r.data?.target_collaboration;
  if (r.code !== 0 || !d) return { r, body: null, reason: "读详情失败" };
  const creators = (d.creators ?? []).map((c) => c.creator_open_id).filter((x): x is string => !!x);
  const prods = d.products ?? [];
  if (d.creator_invited_count !== undefined && d.creator_invited_count !== creators.length) {
    return { r, body: null, reason: `达人列表 ${creators.length} ≠ 计数 ${d.creator_invited_count}` };
  }
  if (d.product_count !== undefined && d.product_count !== prods.length) {
    return { r, body: null, reason: `商品列表 ${prods.length} ≠ 计数 ${d.product_count}` };
  }
  const body: Record<string, unknown> = {
    name: d.name,
    end_time: String(d.end_time),
    products: prods.map((p) => {
      const o: Record<string, unknown> = { id: p.id, commission_rate: p.commission?.rate };
      if (p.commission?.shop_ads_commission_rate !== undefined) o.target_ad_commission_rate = p.commission.shop_ads_commission_rate;
      return o;
    }),
    creator_user_open_ids: creators,
    seller_contact_info: d.seller_contact_info ?? {},
    free_sample_rule: {
      has_free_sample: d.free_sample_rule?.has_free_sample ?? true,
      is_sample_approval_exempt: d.free_sample_rule?.is_sample_approval_exempt ?? false,
    },
  };
  return { r, body, reason: "", detail: d };
}

/**
 * 计划名长度/字符上限实测：对已有计划逐个改名（不新建计划、不发消息），记录哪些被拒，最后改回原名。
 * 98001004 = 平台校验拒绝、未修改。
 */
async function actionNameProbe(shop: Shop, b: Record<string, unknown>) {
  if (b.confirm !== "SEND") bad('会临时修改计划名称（最后改回原名）。确认请在 body 里加 "confirm":"SEND"');
  const tcId = String(b.tc_id ?? "").trim();
  if (!tcId) bad("tc_id 必填");
  const base = await loadTcForUpdate(shop, tcId);
  if (!base.body) return { stopped_at: "load_detail", reason: base.reason, detail: step("detail", base.r, null) };
  const original = String(base.body.name ?? "");
  const names = Array.isArray(b.names) && b.names.length
    ? (b.names as unknown[]).map(String)
    : [
      "PH-AR141-20261111-yunge-01", // 26 字符：R13 用 SKU 简码
      "P0-PH-NAMETEST-30-CHARS-XXXXXX", // 30
      "P0-PH-NAMETEST-35-CHARS-XXXXXXXXXXX", // 35
      "P0-PH-NAMETEST-40-CHARS-XXXXXXXXXXXXXXXX", // 40
      "PH-1731250718136961014-20261111-01", // 34：R13 用 19 位商品 ID
      "PH-AR141-20261111-林丽洪-01", // 中文 BD 名
      "PH-1731250718136961014-20261111-林丽洪-01", // 中文 + 长 ID
    ];
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const results: unknown[] = [];
  for (const n of names) {
    const r = await ttsCall({
      ...T,
      method: "PUT",
      path: `/affiliate_seller/202508/target_collaborations/${tcId}`,
      body: { ...base.body, name: n },
      write: true,
    });
    results.push({ name: n, length: [...n].length, utf8_bytes: new TextEncoder().encode(n).length, ok: r.code === 0, code: r.code, message: r.message });
  }
  const restore = await ttsCall({
    ...T,
    method: "PUT",
    path: `/affiliate_seller/202508/target_collaborations/${tcId}`,
    body: { ...base.body, name: original },
    write: true,
  });
  return { tc_id: tcId, original_name: original, results, restore: step("restore_name", restore, restore.data) };
}

/**
 * 后续阶段（P4 回复通知 / P5 漏斗 / R7 冲突）要用的接口，一次性只读核验路径与返回结构。
 * 不调用「标记已读」：它会清掉 BD 在后台看到的未读提示。
 */
async function actionCheck2(shop: Shop, b: Record<string, unknown>) {
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const tcId = String(b.tc_id ?? "").trim();
  const productIds = strList(b.product_id, b.product_ids);
  const out: Record<string, unknown> = {};
  out.latest_unread = step("latest_unread", await ttsCall({ ...T, method: "GET", path: "/affiliate_seller/202412/conversations/messages/list/newest" }));
  out.inbox_counts = step("inbox_counts", await ttsCall({ ...T, method: "GET", path: "/affiliate_seller/202608/conversations/group_counts" }));
  const p1 = await ttsCall<{ next_page_token?: string; has_more?: boolean }>({
    ...T, method: "GET", path: "/affiliate_seller/202412/conversations", query: { page_size: 5, only_need_conversation_id: true },
  });
  out.conversations_page1 = step("conversations_page1", p1);
  if (p1.data?.next_page_token) {
    out.conversations_page2 = step("conversations_page2", await ttsCall({
      ...T, method: "GET", path: "/affiliate_seller/202412/conversations",
      query: { page_size: 5, only_need_conversation_id: true, page_token: p1.data.next_page_token },
    }));
  }
  out.sample_applications = step("sample_applications", await ttsCall({
    ...T, method: "POST", path: "/affiliate_seller/202508/sample_applications/search", query: { page_size: 10 }, body: {},
  }));
  if (tcId) {
    out.sample_applications_by_tc = step("sample_applications_by_tc", await ttsCall({
      ...T, method: "POST", path: "/affiliate_seller/202508/sample_applications/search", query: { page_size: 10 },
      body: { target_collabration_id: tcId },
    }));
  }
  const now = Math.floor(Date.now() / 1000);
  out.affiliate_orders_7d = step("affiliate_orders_7d", await ttsCall({
    ...T, method: "POST", path: "/affiliate_seller/202410/orders/search", query: { page_size: 5 },
    body: { create_time_ge: now - 7 * 86400, create_time_lt: now },
  }));
  if (tcId) {
    const det = await ttsCall<{ target_collaboration?: TcDetail }>({
      ...T, method: "GET", path: `/affiliate_seller/202508/target_collaborations/${tcId}`,
    });
    const creators = (det.data?.target_collaboration?.creators ?? []).map((c) => c.creator_open_id).filter((x): x is string => !!x);
    const tcProducts = (det.data?.target_collaboration?.products ?? []).map((p) => p.id).filter((x): x is string => !!x);
    const promo: unknown[] = [];
    for (const id of creators.slice(0, 3)) {
      promo.push(step("creator_promotion_details", await ttsCall({
        ...T, method: "POST", path: "/affiliate_seller/202608/target_collaborations/creator_promotion_details/query",
        body: { creator_user_open_id: id, invitation_group_id: tcId },
      })));
    }
    out.creator_promotion_details = promo;
    // 冲突检查：本计划达人 × 本计划商品（应报冲突，验证 R7 预检口径）＋ 额外商品（应不冲突）
    out.conflicts_check = step("conflicts_check", await ttsCall({
      ...T, method: "POST", path: "/affiliate_seller/202605/target_collaborations/conflicts/check",
      body: { creator_open_id_list: creators.slice(0, 10), product_id_list: [...new Set([...tcProducts, ...productIds])].slice(0, 20) },
    }));
  }
  return out;
}

// ── recon：订单 / 财务对账用的只读批量拉取（2026-11-16）────────────────────────
// 输出为「列名 + 行数组」的紧凑格式，便于整段复制给 Claude 用代码逐单比对。
const REGION_UTC_OFFSET: Record<string, number> = { PH: 8, MY: 8, SG: 8, TH: 7, VN: 7, ID: 7, JP: 9, GB: 0, US: -8, MX: -6, BR: -3 };
const toCents = (v: unknown) => Math.round(Number(v ?? 0) * 100) || 0;
const fromCents = (c: number) => (c / 100).toFixed(2);

/** date=YYYY-MM-DD（店铺本地时区的一天）→ [from, to) 秒级时间戳 */
function localDayWindow(shop: Shop, date: string): { from: number; to: number; utc_offset: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad("date 格式应为 YYYY-MM-DD（店铺本地时区）");
  const off = REGION_UTC_OFFSET[(shop.region ?? "").toUpperCase()];
  if (off === undefined) bad(`未配置 ${shop.region} 的时区，请改用 from/to 时间戳`);
  const from = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - off * 3600;
  return { from, to: from + 86400, utc_offset: off };
}

type ApiOrder = {
  id: string; status?: string; create_time?: number; cancel_time?: number;
  payment?: Record<string, string>;
  line_items?: Array<{ sku_id?: string; original_price?: string; sale_price?: string; seller_discount?: string; platform_discount?: string }>;
};

async function reconOrders(shop: Shop, b: Record<string, unknown>) {
  const win = b.date ? localDayWindow(shop, String(b.date)) : { from: Number(b.from), to: Number(b.to), utc_offset: null };
  if (!Number.isFinite(win.from) || !Number.isFinite(win.to) || win.to <= win.from) bad("需要 date，或 from/to（秒级时间戳，左闭右开）");
  const maxPages = Math.min(Number(b.max_pages ?? 40), 80);
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const rows: unknown[] = [];
  let pageToken = "", pages = 0, total: number | null = null, lastErr: unknown = null;
  do {
    const r = await ttsCall<{ orders?: ApiOrder[]; next_page_token?: string; total_count?: number }>({
      ...T, method: "POST", path: "/order/202309/orders/search",
      query: { page_size: 100, sort_field: "create_time", sort_order: "ASC", page_token: pageToken },
      body: { create_time_ge: win.from, create_time_lt: win.to },
    });
    pages++;
    if (r.code !== 0) { lastErr = step("orders_search", r); break; }
    total = r.data?.total_count ?? total;
    for (const o of r.data?.orders ?? []) {
      const p = o.payment ?? {};
      // 一个 line_item = 一件；按 SKU 汇总成 sku:件数:原价合计:售价合计:商家折扣合计:平台折扣合计
      const agg = new Map<string, number[]>();
      for (const li of o.line_items ?? []) {
        const k = li.sku_id ?? "";
        const a = agg.get(k) ?? [0, 0, 0, 0, 0];
        a[0] += 1; a[1] += toCents(li.original_price); a[2] += toCents(li.sale_price);
        a[3] += toCents(li.seller_discount); a[4] += toCents(li.platform_discount);
        agg.set(k, a);
      }
      const skus = [...agg.entries()].map(([k, a]) => [k, a[0], ...a.slice(1).map(fromCents)].join(":")).join(";");
      rows.push([
        o.id, o.status ?? "", o.create_time ?? 0, o.cancel_time ?? 0, p.currency ?? "",
        p.original_total_product_price ?? "", p.sub_total ?? "", p.seller_discount ?? "", p.platform_discount ?? "",
        p.original_shipping_fee ?? "", p.shipping_fee ?? "", p.shipping_fee_platform_discount ?? "", p.shipping_fee_seller_discount ?? "",
        p.payment_platform_discount ?? "", p.tax ?? "", p.total_amount ?? "", skus,
      ]);
    }
    pageToken = r.data?.next_page_token ?? "";
  } while (pageToken && pages < maxPages);
  return {
    kind: "orders", shop_id: shop.shop_id, region: shop.region, date: b.date ?? null, utc_offset: win.utc_offset,
    from: win.from, to: win.to, api_total_count: total, rows_returned: rows.length, pages, truncated: Boolean(pageToken), error: lastErr,
    columns: ["order_id", "status", "create_time", "cancel_time", "currency", "original_total_product_price", "sub_total", "seller_discount",
      "platform_discount", "original_shipping_fee", "shipping_fee", "shipping_fee_platform_discount", "shipping_fee_seller_discount",
      "payment_platform_discount", "tax", "total_amount", "skus(sku:qty:orig:sale:seller_disc:platform_disc;...)"],
    rows,
  };
}

type ApiStmtTx = {
  id?: string; type?: string; order_id?: string; order_create_time?: number; adjustment_id?: string; adjustment_order_id?: string;
  settlement_amount?: string; revenue_amount?: string; shipping_cost_amount?: string; fee_tax_amount?: string; adjustment_amount?: string;
};

async function reconStatement(shop: Shop, b: Record<string, unknown>) {
  const sid = String(b.statement_id ?? "").trim();
  if (!/^\d+$/.test(sid)) bad("statement_id 必填（财务表「对账单」页的结算单 ID）");
  const maxPages = Math.min(Number(b.max_pages ?? 40), 80);
  const T = { accessToken: shop.access_token, shopCipher: shop.shop_cipher };
  const rows: unknown[] = [];
  let pageToken = "", pages = 0, header: Record<string, unknown> | null = null, lastErr: unknown = null;
  do {
    const r = await ttsCall<Record<string, unknown> & { transactions?: ApiStmtTx[]; next_page_token?: string }>({
      ...T, method: "GET", path: `/finance/202501/statements/${sid}/statement_transactions`,
      query: { page_size: 100, sort_field: "order_create_time", sort_order: "ASC", page_token: pageToken },
    });
    pages++;
    if (r.code !== 0) { lastErr = step("statement_transactions", r); break; }
    const d = r.data ?? {};
    if (!header) {
      header = {
        id: d.id, create_time: d.create_time, status: d.status, currency: d.currency, payable_amount: d.payable_amount,
        total_settlement_amount: d.total_settlement_amount, total_reserve_amount: d.total_reserve_amount,
        total_settlement_breakdown: d.total_settlement_breakdown, total_count: d.total_count,
      };
    }
    for (const t of d.transactions ?? []) {
      rows.push([
        t.order_id ?? t.adjustment_order_id ?? "", t.type ?? "", t.id ?? "", t.adjustment_id ?? "", t.order_create_time ?? 0,
        t.settlement_amount ?? "", t.revenue_amount ?? "", t.shipping_cost_amount ?? "", t.fee_tax_amount ?? "", t.adjustment_amount ?? "",
      ]);
    }
    pageToken = (d.next_page_token as string) ?? "";
  } while (pageToken && pages < maxPages);
  return {
    kind: "statement", shop_id: shop.shop_id, region: shop.region, statement_id: sid, header, rows_returned: rows.length,
    pages, truncated: Boolean(pageToken), error: lastErr,
    columns: ["order_id", "type", "transaction_id", "adjustment_id", "order_create_time", "settlement_amount", "revenue_amount",
      "shipping_cost_amount", "fee_tax_amount", "adjustment_amount"],
    rows,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // 先读 body：cron 身份只放行 refresh_due
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(b.action ?? "");
    if (action === "refresh_due" && await cronAuthed(req)) {
      return json(await refreshDue(Number(b.within_hours) > 0 ? Number(b.within_hours) : 48, "cron"));
    }
    const acc = await requireAdmin(req);

    if (action === "apps") return json({ apps: await listApps() });
    if (action === "save_app") return json(await saveApp(b, acc.name));
    if (action === "refresh_due") {
      return json(await refreshDue(Number(b.within_hours) > 0 ? Number(b.within_hours) : 48, acc.name));
    }
    if (action === "auth_url") {
      const app = await ttsApp(appCode(b.app));
      if (!app.serviceId) bad(`应用 ${app.code} 未填 Service ID（Partner Center → 应用详情页）。也可以直接用 Partner Center 里「复制授权链接」`);
      return json({ url: `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(app.serviceId)}` });
    }
    if (action === "exchange") {
      const code = String(b.auth_code ?? b.code ?? "").trim();
      if (!code) bad("auth_code 必填（授权后跳转地址里 code= 后面那串，30 分钟内有效、只能用一次）");
      const app = await ttsApp(appCode(b.app));
      return json(await saveToken(await ttsExchangeCode(code, app), acc.name, app));
    }
    if (action === "shops") {
      return json({ shops: await listShops() });
    }
    if (action === "refresh") {
      const shop = await loadShop(b.shop_id);
      const app = await ttsApp(shop.app_code ?? TTS_DEFAULT_APP);
      return json(await saveToken(await ttsRefreshToken(shop.refresh_token, app), acc.name, app));
    }
    if (action === "read") {
      const handles = Array.isArray(b.handles) ? (b.handles as unknown[]).map(String).filter(Boolean) : [];
      return json(await actionRead(await loadShop(b.shop_id), handles));
    }
    if (action === "write") {
      return json(await actionWrite(await loadShop(b.shop_id), b, acc.name));
    }
    if (action === "name_probe") {
      return json(await actionNameProbe(await loadShop(b.shop_id), b));
    }
    if (action === "check2") {
      return json(await actionCheck2(await loadShop(b.shop_id), b));
    }
    if (action === "add_to_tc") {
      return json(await actionAddToTc(await loadShop(b.shop_id), b));
    }
    if (action === "recon") {
      const shop = await loadShop(b.shop_id);
      const kind = String(b.kind ?? "");
      if (kind === "orders") return json(await reconOrders(shop, b));
      if (kind === "statement") return json(await reconStatement(shop, b));
      bad("recon 的 kind 只能是 orders（按下单日拉订单）或 statement（按结算单 ID 拉逐单结算）");
    }
    if (action === "raw") {
      const shop = await loadShop(b.shop_id);
      const path = String(b.path ?? "");
      const method = String(b.method ?? "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) bad("method 只能是 GET/POST/PUT/DELETE");
      if (!/^\/(affiliate_seller|authorization|product|analytics|order|finance|promotion|return_refund|logistics|fulfillment)\//.test(path)) {
        bad("raw 只允许 /affiliate_seller/ /authorization/ /product/ /analytics/ /order/ /finance/ /promotion/ /return_refund/ /logistics/ /fulfillment/ 开头的 path");
      }
      // 读写由 _shared/tts.ts 的只读闸门统一判断：写接口（除定向计划新建/修改）一律拦截
      const r = await ttsCall({
        method,
        path,
        accessToken: shop.access_token,
        shopCipher: shop.shop_cipher,
        query: (b.query as Record<string, string>) ?? {},
        body: b.body,
        write: method !== "GET",
      });
      return json(step("raw", r));
    }
    bad("action 只能是 apps / save_app / refresh_due / auth_url / exchange / shops / refresh / read / write / add_to_tc / name_probe / check2 / recon / raw");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
