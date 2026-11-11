// 联盟达人外联 P0 实测工具（仅管理员）。在「API测试」页粘贴 JSON 调用，例：
//   {"function":"tts-p0-probe","body":{"action":"shops"}}
//
// action：
//   auth_url                                    返回店铺授权链接（需 secret TTS_SERVICE_ID = Partner Center 应用页的 Service ID）
//   exchange {auth_code}                        auth_code → token → Get Authorized Shops → 写 tts_shops（返回不含 token）
//   shops                                       列出已授权店铺（不含 token）
//   refresh  {shop_id}                          用 refresh_token 换新 token（验证自动刷新可行）
//   read     {shop_id, handles:[...]}           只读实测：名额 / 筛选项 / 逐个 handle 解析 / 资格检查 / 外联记录 / 会话列表 / 计划列表
//   write    {shop_id, handles:[...], product_ids:[...], commission_pct, ad_commission_pct?, contact, message_text, tc_message?, send_card?, confirm:"SEND"}
//            （也兼容单个 handle / product_id）
//                                               真实写入：建 1 个定向计划（多达人×多商品） → 查详情 → 生成邀请链接 → 取/建会话 → 发私信（+可选计划卡片）
//                                               会消耗 1 个本周外联名额，并真的给达人发消息
//   add_to_tc {shop_id, tc_id, handles?, product_ids?, commission_pct?, ad_commission_pct?, message_text?, send_card?, confirm:"SEND"}
//                                               已有定向计划增发达人/商品：读详情 → 合并 → 全量 PUT → 回读校验老达人未丢 → 只给新达人发消息
//   name_probe {shop_id, tc_id, names?, confirm:"SEND"}  已有计划逐个改名测名称上限，最后改回原名（不新建、不发消息）
//   check2   {shop_id, tc_id?, product_ids?}     只读：最新未读/收件箱计数/会话分页/样品申请/联盟订单/计划内推广明细/冲突检查
//   raw      {shop_id, method, path, query?, body?}  任意 /affiliate_seller/、/authorization/ 接口单次调用（补测用）
//
// 与 `_shared/tiktok.ts`（Business API）完全独立；只读写 tts_shops 一张表。
import { admin, requireAdmin } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/feishu.ts";
import { normalizeHandle, pctToRate, ttsCall, type TtsResult, ttsExchangeCode, ttsRefreshToken, type TtsToken } from "../_shared/tts.ts";

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
};

const PUBLIC_COLS =
  "shop_id,shop_code,shop_name,region,seller_type,seller_name,seller_base_region,user_type,access_expires_at,refresh_expires_at,scopes,contact_info,status,authorized_by,updated_at";

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

async function saveToken(tok: TtsToken, operator: string) {
  const shopsRes = await ttsCall<{ shops?: Array<Record<string, string>> }>({
    method: "GET",
    path: "/authorization/202309/shops",
    accessToken: tok.access_token,
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
  }));
  if (rows.length) {
    const { error } = await admin().from("tts_shops").upsert(rows, { onConflict: "shop_id" });
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
  };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const acc = await requireAdmin(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(b.action ?? "");

    if (action === "auth_url") {
      const sid = (Deno.env.get("TTS_SERVICE_ID") ?? "").trim();
      if (!sid) bad("缺少 Supabase secret：TTS_SERVICE_ID（Partner Center → 应用详情页的 Service ID）。也可以直接用 Partner Center 里「复制授权链接」");
      return json({ url: `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(sid)}` });
    }
    if (action === "exchange") {
      const code = String(b.auth_code ?? b.code ?? "").trim();
      if (!code) bad("auth_code 必填（授权后跳转地址里 code= 后面那串，30 分钟内有效、只能用一次）");
      return json(await saveToken(await ttsExchangeCode(code), acc.name));
    }
    if (action === "shops") {
      const { data, error } = await admin().from("tts_shops").select(PUBLIC_COLS).order("region");
      if (error) throw error;
      return json({ shops: data });
    }
    if (action === "refresh") {
      const shop = await loadShop(b.shop_id);
      return json(await saveToken(await ttsRefreshToken(shop.refresh_token), acc.name));
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
    if (action === "raw") {
      const shop = await loadShop(b.shop_id);
      const path = String(b.path ?? "");
      if (!/^\/(affiliate_seller|authorization)\//.test(path)) bad("raw 只允许 /affiliate_seller/ 或 /authorization/ 开头的 path");
      const method = String(b.method ?? "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) bad("method 只能是 GET/POST/PUT/DELETE");
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
    bad("action 只能是 auth_url / exchange / shops / refresh / read / write / add_to_tc / name_probe / check2 / raw");
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400;
    return json({ error: (error as Error).message }, status);
  }
});
