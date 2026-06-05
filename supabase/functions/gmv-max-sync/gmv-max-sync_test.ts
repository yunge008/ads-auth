// Unit tests for gmv-max-sync.
// - fetchCampaigns: filtering enum + total_page pagination, per advertiser
// - fetchReport: omits gmv_max_promotion_types, auto metrics, empty filters, de-dupes pages
// - ttGet: retries on "Too many requests" with backoff, fails fast on other errors
import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { fetchCampaigns, fetchReport, ttGet } from "./index.ts";

type Call = { path: string; params: Record<string, string> };

function makeTtGet(
  responder: (path: string, params: Record<string, string>) => Record<string, unknown>,
) {
  const calls: Call[] = [];
  const fn = async (_token: string, path: string, params: Record<string, string>) => {
    calls.push({ path, params });
    return responder(path, params);
  };
  return { fn, calls };
}

const ADVERTISERS = Array.from({ length: 13 }, (_, i) => `adv_${String(i + 1).padStart(2, "0")}`);

// ---------- fetchCampaigns: filtering + total_page pagination (per advertiser) ----------
for (const adv of ADVERTISERS) {
  Deno.test(`fetchCampaigns[${adv}] PRODUCT_GMV_MAX + paginates by total_page`, async () => {
    const TOTAL_PAGE = 3;
    const { fn, calls } = makeTtGet((path, params) => {
      assertEquals(path, "/gmv_max/campaign/get/");
      assertEquals(params.advertiser_id, adv);
      const filt = JSON.parse(params.filtering);
      assertEquals(filt.gmv_max_promotion_types, ["PRODUCT_GMV_MAX"]);
      const page = Number(params.page);
      return {
        list: [{ campaign_id: `${adv}_c${page}_a` }, { campaign_id: `${adv}_c${page}_b` }],
        page_info: { page, total_page: TOTAL_PAGE, total_number: TOTAL_PAGE * 2 },
      };
    });
    const ids = await fetchCampaigns("tok", adv, fn);
    assertEquals(calls.length, TOTAL_PAGE);
    assertEquals(ids.length, TOTAL_PAGE * 2);
  });
}

// ---------- fetchReport: drops gmv_max_promotion_types + auto creative metrics ----------
for (const adv of ADVERTISERS) {
  Deno.test(`fetchReport[${adv}] creative-level omits gmv_max_promotion_types`, async () => {
    const batch = [`${adv}_c1`, `${adv}_c2`, `${adv}_c3`];
    const igids = [`${adv}_g1`, `${adv}_g2`];
    const { fn, calls } = makeTtGet((path, params) => {
      assertEquals(path, "/gmv_max/report/get/");
      assertEquals(params.advertiser_id, adv);
      const filt = JSON.parse(params.filtering);
      assert(!Array.isArray(filt), "filtering must be object");
      assert(!("gmv_max_promotion_types" in filt), "creative-level must omit promotion type");
      assertEquals(filt.campaign_ids, batch);
      assertEquals(filt.item_group_ids, igids);
      const dims = JSON.parse(params.dimensions);
      assert(dims.includes("item_id"));
      const metrics = JSON.parse(params.metrics);
      assert(metrics.includes("creative_delivery_status"));
      assertEquals(params.page_size, "1000");
      return {
        list: [
          { dimensions: { campaign_id: batch[0], item_group_id: "g1", item_id: "v1", stat_time_day: "2026-01-01" }, metrics: { cost: 1, gross_revenue: 2 } },
        ],
        page_info: { page: 1, total_page: 1, total_number: 1 },
      };
    });
    const rows = await fetchReport(
      "tok", adv, "shop", "2026-01-01", "2026-01-02",
      ["campaign_id", "item_group_id", "item_id", "stat_time_day"],
      { campaign_ids: batch, item_group_ids: igids },
      fn,
    );
    assertEquals(calls.length, 1);
    assertEquals(rows.length, 1);
  });
}

Deno.test("fetchReport sends empty extraFilter as a legal object", async () => {
  const { fn, calls } = makeTtGet((_path, params) => {
    assertEquals(params.filtering, "{}");
    return { list: [], page_info: { page: 1, total_page: 0 } };
  });
  await fetchReport("t", "a", "s", "2026-01-01", "2026-01-02", ["campaign_id"], {}, undefined, fn);
  assertEquals(calls.length, 1);
});

Deno.test("fetchReport non-creative metrics exclude creative fields", async () => {
  const { fn } = makeTtGet((_path, params) => {
    const metrics = JSON.parse(params.metrics);
    assertEquals(metrics, ["cost", "orders", "gross_revenue"]);
    assert(!metrics.includes("creative_delivery_status"));
    return { list: [], page_info: { page: 1, total_page: 0 } };
  });
  await fetchReport("t", "a", "s", "2026-01-01", "2026-01-02", ["campaign_id", "item_group_id"], {}, undefined, fn);
});

Deno.test("fetchReport de-dupes duplicate rows across pages", async () => {
  const { fn, calls } = makeTtGet((_path, params) => {
    const page = Number(params.page);
    return {
      list: [
        { dimensions: { campaign_id: "c1", item_group_id: "g1", item_id: "v1", stat_time_day: "2026-01-01" }, metrics: { cost: page } },
      ],
      page_info: { page, total_page: 2, total_number: 2 },
    };
  });
  const rows = await fetchReport("t", "a", "s", "2026-01-01", "2026-01-02", ["campaign_id", "item_group_id", "item_id", "stat_time_day"], {}, undefined, fn);
  assertEquals(calls.length, 2);
  assertEquals(rows.length, 1);
});

// ---------- pagination short-circuit ----------
Deno.test("fetchReport stops after one page when total_page=1", async () => {
  const { fn, calls } = makeTtGet(() => ({
    list: [{ dimensions: {}, metrics: {} }],
    page_info: { page: 1, total_page: 1, total_number: 1 },
  }));
  await fetchReport("t", "a", "s", "2026-01-01", "2026-01-02", ["item_id"], {}, undefined, fn);
  assertEquals(calls.length, 1);
});

Deno.test("fetchCampaigns stops on empty list", async () => {
  const { fn, calls } = makeTtGet(() => ({ list: [], page_info: { page: 1, total_page: 0 } }));
  const ids = await fetchCampaigns("t", "a", fn);
  assertEquals(calls.length, 1);
  assertEquals(ids.length, 0);
});

// ---------- ttGet rate-limit retry / fail-fast ----------
Deno.test("ttGet retries on 'Too many requests' then succeeds", async () => {
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts < 3) {
      return new Response(JSON.stringify({ code: 40100, message: "Too many requests" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 });
  };
  try {
    const data = await ttGet("tok", "/x/", {}, 5, async () => {});
    assertEquals(attempts, 3);
    assertEquals((data as { ok: boolean }).ok, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("ttGet fails fast on non-rate errors (no retry)", async () => {
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(JSON.stringify({ code: 40002, message: "Invalid filter" }), { status: 200 });
  };
  try {
    await assertRejects(() => ttGet("tok", "/x/", {}, 5, async () => {}), Error, "Invalid filter");
    assertEquals(attempts, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});
