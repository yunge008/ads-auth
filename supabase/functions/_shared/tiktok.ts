const TT = "https://business-api.tiktok.com/open_api/v1.3";

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type TimeBudgetChecker = () => void;

// Shared TikTok GET client: rate-limited to about 3 QPS and retries throttling/network failures.
export async function ttGet(
  token: string,
  path: string,
  params: Record<string, string>,
  retries = 5,
  wait: (ms: number) => Promise<void> = sleep,
  ensureTime?: TimeBudgetChecker,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < retries; attempt++) {
    ensureTime?.();
    const url = new URL(`${TT}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let json: Record<string, unknown>;
    try {
      const response = await fetch(url, {
        headers: { "Access-Token": token },
        signal: controller.signal,
      });
      json = await response.json().catch(() => ({}));
    } catch (error) {
      if (attempt < retries - 1) {
        await wait(1000 * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`${path}: network/timeout ${(error as Error).message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (json.code === 0) {
      await wait(150);
      return (json.data ?? {}) as Record<string, unknown>;
    }
    const message = String(json.message ?? "");
    const rateLimited = message.includes("Too many requests") ||
      message.includes("Request too frequent") ||
      message.toLowerCase().includes("frequent") || json.code === 40100 || json.code === 50002;
    if (rateLimited && attempt < retries - 1) {
      ensureTime?.();
      await wait(3000 * Math.pow(2, attempt));
      continue;
    }
    throw new Error(`${path}: ${message || "unknown"}`);
  }
  throw new Error(`${path}: max retries exceeded`);
}
