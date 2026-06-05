// Unit tests for gmv-max-sync: filtering enum + pagination via total_page.
// Covers all 13 advertisers independently.
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { fetchCampaigns, fetchReport } from "./index.ts";

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

// ---------- fetchCampaigns: filtering + total_page pagination ----------
for (const adv of ADVERTISERS) {
  Deno.test(`fetchCampaigns[${adv}] sends PRODUCT_GMV_MAX filtering and paginates by total_page`, async () => {
    const TOTAL_PAGE = 3;
    const { fn, calls } = makeTtGet((path, params) => {
      assertEquals(path, "/gmv_max/campaign/get/");
      assertEquals(params.advertiser_id, adv);
      // filtering must be present and an object with PRODUCT_GMV_MAX
      const filt = JSON.parse(params.filtering);
      assertEquals(filt.gmv_max_promotion_types, ["PRODUCT_GMV_MAX"]);
      const page = Number(params.page);
      return {
        list: [{ campaign_id: `${adv}_c${page}_a` }, { campaign_id: `${adv}_c${page}_b` }],
        page_info: { page, total_page: TOTAL_PAGE, total_number: TOTAL_PAGE * 2 },
      };
    });
    const ids = await fetchCampaigns("tok", adv, fn);
    assertEquals(calls.length, TOTAL_PAGE, "should stop at total_page");
    assertEquals(ids.length, TOTAL_PAGE * 2);
    assert(ids.every((id) => id.startsWith(`${adv}_`)));
  });
}

// ---------- fetchReport: group-level keeps PRODUCT filter; creative-level drops it ----------
for (const adv of ADVERTISERS) {
  Deno.test(`fetchReport[${adv}] group-level: filtering object has PRODUCT + extras, paginates by total_page`, async () => {
    const TOTAL_PAGE = 2;
    const { fn, calls } = makeTtGet((path, params) => {
      assertEquals(path, "/gmv_max/report/get/");
      assertEquals(params.advertiser_id, adv);
      const filt = JSON.parse(params.filtering);
      assert(!Array.isArray(filt), "filtering must be object");
      assertEquals(filt.gmv_max_promotion_types, ["PRODUCT"]);
      assertEquals(filt.campaign_ids, [`${adv}_cid`]);
      const page = Number(params.page);
      return {
        list: [{ dimensions: { item_group_id: `${adv}_g${page}` }, metrics: {} }],
        page_info: { page, total_page: TOTAL_PAGE, total_number: TOTAL_PAGE },
      };
    });
    const rows = await fetchReport(
      "tok", adv, "shop", "2026-01-01", "2026-01-02",
      ["campaign_id", "item_group_id", "stat_time_day"],
      { campaign_ids: [`${adv}_cid`] },
      undefined,
      fn,
    );
    assertEquals(calls.length, TOTAL_PAGE);
    assertEquals(rows.length, TOTAL_PAGE);
  });

  Deno.test(`fetchReport[${adv}] creative-level (item_id): filtering object OMITS gmv_max_promotion_types`, async () => {
    const { fn } = makeTtGet((_path, params) => {
      const filt = JSON.parse(params.filtering);
      assert(!Array.isArray(filt));
      assert(!("gmv_max_promotion_types" in filt), "must omit gmv_max_promotion_types for item_id dims");
      assertEquals(filt.campaign_ids, [`${adv}_cid`]);
      assertEquals(filt.item_group_ids, [`${adv}_igid`]);
      return { list: [], page_info: { page: 1, total_page: 1, total_number: 0 } };
    });
    await fetchReport(
      "tok", adv, "shop", "2026-01-01", "2026-01-02",
      ["campaign_id", "item_group_id", "item_id", "stat_time_day"],
      { campaign_ids: [`${adv}_cid`], item_group_ids: [`${adv}_igid`] },
      undefined,
      fn,
    );
  });
}

// ---------- single-page short-circuit ----------
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
