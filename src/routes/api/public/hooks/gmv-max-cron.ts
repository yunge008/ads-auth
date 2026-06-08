// Cron entrypoint for GMV Max sync.
// Called by pg_cron via net.http_post. Loops over gmv-max-sync, automatically
// resuming on remaining_advertiser_ids / remaining_campaign_ids, until either
// nothing remains or the soft 5-minute wall-clock budget is hit.
//
// Auth: requires `apikey: <SUPABASE_ANON_KEY>` header. /api/public/* bypasses
// platform-level auth, so we re-check anon key here to prevent random callers.
// Downstream call to gmv-max-sync uses `x-cron-key` (vault secret) so the edge
// function bypasses the admin-passcode check.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const TIMEZONE_OFFSET_MINUTES = 8 * 60; // CST (UTC+8)
const HARD_BUDGET_MS = 5 * 60 * 1000;
const MAX_ROUNDS = 40;

type Mode = "yesterday" | "today";

function localDate(offsetDays = 0): string {
  const now = Date.now() + TIMEZONE_OFFSET_MINUTES * 60_000 + offsetDays * 86400_000;
  return new Date(now).toISOString().slice(0, 10);
}

type SyncResp = {
  upserted?: number;
  remaining_advertiser_ids?: string[];
  remaining_campaign_ids?: string[];
  stopped_before_timeout?: { advertiser_id?: string; remaining_campaign_ids?: string[]; remaining_advertiser_ids?: string[] } | null;
  errors?: Array<{ advertiser_id?: string; error: string }>;
  batch_stats?: Array<{ advertiser_id: string; rows: number }>;
};

export const Route = createFileRoute("/api/public/hooks/gmv-max-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = process.env.SUPABASE_URL!;
        const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

        // 1. Verify caller (pg_cron passes apikey header)
        const callerKey = request.headers.get("apikey") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        if (!anonKey || callerKey !== anonKey) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
        }

        // 2. Parse mode
        let mode: Mode = "today";
        try {
          const body = (await request.json()) as { mode?: Mode };
          if (body.mode === "yesterday" || body.mode === "today") mode = body.mode;
        } catch { /* empty body ok */ }
        const date = mode === "yesterday" ? localDate(-1) : localDate(0);

        // 3. Fetch vault secret for x-cron-key
        const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const { data: secretRow, error: secretErr } = await admin
          .schema("vault")
          .from("decrypted_secrets")
          .select("decrypted_secret")
          .eq("name", "gmv_max_cron_secret")
          .maybeSingle();
        if (secretErr || !secretRow?.decrypted_secret) {
          return new Response(JSON.stringify({ error: "missing vault secret gmv_max_cron_secret" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        const cronKey = secretRow.decrypted_secret as string;

        // 4. Loop calling gmv-max-sync
        const syncUrl = `${supabaseUrl}/functions/v1/gmv-max-sync`;
        const startedAt = Date.now();
        let advertiserQueue: string[] | undefined; // undefined = first call, sync all
        let campaignQueue: string[] | undefined;
        let totalUpserted = 0;
        const allErrors: Array<{ advertiser_id?: string; error: string }> = [];
        let rounds = 0;
        let lastRemainingKey = "";

        while (rounds < MAX_ROUNDS && Date.now() - startedAt < HARD_BUDGET_MS) {
          rounds++;
          const reqBody: Record<string, unknown> = { start_date: date, end_date: date, max_runtime_ms: 80000 };
          if (advertiserQueue?.length) reqBody.advertiser_ids = advertiserQueue;
          if (campaignQueue?.length) reqBody.campaign_ids = campaignQueue;

          let resp: SyncResp;
          try {
            const r = await fetch(syncUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-cron-key": cronKey,
                "apikey": anonKey,
                "Authorization": `Bearer ${anonKey}`,
              },
              body: JSON.stringify(reqBody),
            });
            if (!r.ok) {
              const text = await r.text();
              allErrors.push({ error: `sync HTTP ${r.status}: ${text.slice(0, 300)}` });
              break;
            }
            resp = (await r.json()) as SyncResp;
          } catch (e) {
            allErrors.push({ error: `sync fetch failed: ${(e as Error).message}` });
            break;
          }

          totalUpserted += resp.upserted ?? 0;
          if (resp.errors?.length) allErrors.push(...resp.errors);

          const stopped = resp.stopped_before_timeout;
          const remainingAdvs = stopped
            ? [...(stopped.advertiser_id ? [stopped.advertiser_id] : []), ...(stopped.remaining_advertiser_ids ?? [])]
            : (resp.remaining_advertiser_ids ?? []);
          const remainingCampaigns = stopped?.remaining_campaign_ids ?? resp.remaining_campaign_ids ?? [];

          if (remainingAdvs.length === 0 && remainingCampaigns.length === 0) break;

          // Guard against no-progress loops
          const key = `${remainingAdvs.join(",")}|${remainingCampaigns.join(",")}`;
          if (key === lastRemainingKey) {
            allErrors.push({ error: "no progress between rounds, stopping" });
            break;
          }
          lastRemainingKey = key;
          advertiserQueue = remainingAdvs;
          campaignQueue = remainingCampaigns.length ? remainingCampaigns : undefined;
        }

        // 5. Persist run state
        await admin.from("gmv_max_sync_state").upsert({
          id: `cron_${mode}`,
          last_synced_at: new Date().toISOString(),
          note: `rounds=${rounds} upserted=${totalUpserted} errors=${allErrors.length} date=${date}`,
        });

        return Response.json({
          ok: allErrors.length === 0,
          mode,
          date,
          rounds,
          upserted: totalUpserted,
          errors: allErrors.slice(0, 20),
          elapsed_ms: Date.now() - startedAt,
        });
      },
    },
  },
});
