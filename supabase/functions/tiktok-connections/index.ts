// List/update/delete tiktok_connections and per-advertiser country mappings.
// Ops:
//   { op: "list" } -> { connections: [...], countries: {advertiser_id: country}, shops: {...}, active: {advertiser_id: boolean} }
//   { op: "delete", id }                  -> { ok }
//   { op: "update", id, label }           -> { ok }
//   { op: "set_bc", id, bc_id, bc_name }  -> { ok }  // 编辑 BC 名称/BC ID
//   { op: "set_country", advertiser_id, country }  // empty country to clear；首次设置默认 active=false
//   { op: "set_active", advertiser_id, active }    // 国家唯一性只在 active=true 的广告户间强制
import { corsHeaders } from "../_shared/feishu.ts";
import { admin, checkAdminPasscode } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    await checkAdminPasscode(req, "settings");
    const body = (await req.json().catch(() => ({}))) as {
      op?: string;
      id?: string;
      label?: string;
      bc_id?: string;
      bc_name?: string;
      advertiser_id?: string;
      country?: string;
      shop_id?: string;
      shop_name?: string;
      active?: boolean;
    };

    if (body.op === "delete") {
      if (!body.id) throw new Error("id 必填");
      const { error } = await admin().from("tiktok_connections").delete().eq("id", body.id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "update") {
      if (!body.id) throw new Error("id 必填");
      const label = (body.label ?? "").trim();
      if (!label) throw new Error("label 不能为空");
      const { error } = await admin()
        .from("tiktok_connections")
        .update({ label })
        .eq("id", body.id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "set_country") {
      const aid = (body.advertiser_id ?? "").trim();
      if (!aid) throw new Error("advertiser_id 必填");
      const country = (body.country ?? "").trim();
      if (!country) {
        const { error } = await admin()
          .from("advertiser_countries")
          .delete()
          .eq("advertiser_id", aid);
        if (error) throw new Error(error.message);
      } else {
        // 唯一性只在「本广告户自身是启用状态」时才需要检查——已停用的广告户改国家不会造成
        // 同一国家同时存在两个启用广告户，允许随意共享。第一次给广告户设置国家（还没有
        // advertiser_countries 记录）默认落地为停用状态，需要用户手动打开启用开关，
        // 所以不需要在这里校验冲突；已有记录的广告户改国家名称，保持原有 active 状态不变。
        const { data: aidRow } = await admin()
          .from("advertiser_countries")
          .select("active")
          .eq("advertiser_id", aid)
          .maybeSingle();
        const aidIsActive = aidRow ? aidRow.active : false;

        if (aidIsActive) {
          const { data: occupant, error: qErr } = await admin()
            .from("advertiser_countries")
            .select("advertiser_id, active")
            .eq("country", country)
            .neq("advertiser_id", aid)
            .eq("active", true)
            .maybeSingle();
          if (qErr) throw new Error(qErr.message);
          if (occupant) {
            return new Response(
              JSON.stringify({
                error: `国家「${country}」已被启用中的广告户 ${occupant.advertiser_id} 占用，请先停用对方再设置`,
              }),
              { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (aidRow) {
          const { error } = await admin()
            .from("advertiser_countries")
            .update({ country })
            .eq("advertiser_id", aid);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await admin()
            .from("advertiser_countries")
            .insert({ advertiser_id: aid, country, active: false });
          if (error) throw new Error(error.message);
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "set_active") {
      const aid = (body.advertiser_id ?? "").trim();
      if (!aid) throw new Error("advertiser_id 必填");
      if (typeof body.active !== "boolean") throw new Error("active 必填且须为布尔值");

      const { data: existing, error: exErr } = await admin()
        .from("advertiser_countries")
        .select("country")
        .eq("advertiser_id", aid)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) throw new Error("请先设置该广告户的国家，再启用/停用");

      if (body.active) {
        const { data: occupant, error: qErr } = await admin()
          .from("advertiser_countries")
          .select("advertiser_id")
          .eq("country", existing.country)
          .neq("advertiser_id", aid)
          .eq("active", true)
          .maybeSingle();
        if (qErr) throw new Error(qErr.message);
        if (occupant) {
          return new Response(
            JSON.stringify({
              error: `国家「${existing.country}」已被启用中的广告户 ${occupant.advertiser_id} 占用，请先停用对方再启用`,
            }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      const { error } = await admin()
        .from("advertiser_countries")
        .update({ active: body.active })
        .eq("advertiser_id", aid);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "set_shop") {
      const aid = (body.advertiser_id ?? "").trim();
      if (!aid) throw new Error("advertiser_id 必填");
      const shop_id = (body.shop_id ?? "").trim();
      const shop_name = (body.shop_name ?? "").trim();
      // Upsert; if row doesn't exist we need country too — but country is NOT NULL.
      // Read existing row, otherwise require country to be set first.
      const { data: existing } = await admin()
        .from("advertiser_countries")
        .select("country")
        .eq("advertiser_id", aid)
        .maybeSingle();
      if (!existing) {
        throw new Error("请先设置该广告户的国家，再设置店铺信息");
      }
      const { error } = await admin()
        .from("advertiser_countries")
        .update({ shop_id: shop_id || null, shop_name: shop_name || null })
        .eq("advertiser_id", aid);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // default: list connections + country/shop mapping
    const [{ data: conns, error: e1 }, { data: countries, error: e2 }] = await Promise.all([
      admin()
        .from("tiktok_connections")
        .select("id, label, bc_id, bc_name, advertiser_ids, expires_at, created_at, updated_at")
        .order("created_at", { ascending: false }),
      admin().from("advertiser_countries").select("advertiser_id, country, shop_id, shop_name, active"),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    const countryMap: Record<string, string> = {};
    const shopMap: Record<string, { shop_id: string | null; shop_name: string | null }> = {};
    const activeMap: Record<string, boolean> = {};
    for (const r of (countries ?? []) as { advertiser_id: string; country: string; shop_id: string | null; shop_name: string | null; active: boolean }[]) {
      countryMap[r.advertiser_id] = r.country;
      shopMap[r.advertiser_id] = { shop_id: r.shop_id, shop_name: r.shop_name };
      activeMap[r.advertiser_id] = r.active;
    }
    return new Response(
      JSON.stringify({ connections: conns ?? [], countries: countryMap, shops: shopMap, active: activeMap }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
