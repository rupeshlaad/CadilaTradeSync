import { Logger } from '@nestjs/common';

/**
 * Sprint 6.3.1 — Upstox broker-level rate-limit guard.
 *
 * Upstox enforces rate limits per-API, per-user (official rate-limiting page):
 *   - Order APIs (place/modify/cancel):  10 req/sec, 500 req/min, 2000 / 30 min
 *   - All other (data) APIs:             50 req/sec, 500 req/min, 2000 / 30 min
 *
 * This is a lightweight, process-shared sliding-window gate that SPACES the
 * adapter's own outbound HTTP calls so CTS never trips the broker limit. It
 * does NOT touch / redesign copy trading — the copy engine keeps issuing calls
 * exactly as before; each adapter request simply `await`s its slot here first.
 *
 * A single shared instance is used across the per-request adapters (adapters
 * are constructed per call, so the limiter must live at module scope to be
 * effective across them).
 */
type Bucket = 'order' | 'data';

interface Limits {
  perSecond: number;
  perMinute: number;
  per30Min: number;
}

const LIMITS: Record<Bucket, Limits> = {
  order: { perSecond: 10, perMinute: 500, per30Min: 2000 },
  data: { perSecond: 50, perMinute: 500, per30Min: 2000 },
};

const WINDOW_30_MIN = 30 * 60 * 1000;

class UpstoxRateLimiter {
  private readonly logger = new Logger('UpstoxRateLimiter');
  // Recent request timestamps (ms) per bucket for the sliding windows.
  private readonly hits: Record<Bucket, number[]> = { order: [], data: [] };
  // Serialise slot acquisition per bucket so concurrent callers don't race.
  private readonly chain: Record<Bucket, Promise<void>> = {
    order: Promise.resolve(),
    data: Promise.resolve(),
  };

  async acquire(bucket: Bucket): Promise<void> {
    const run = this.chain[bucket].then(() => this.reserve(bucket));
    // Keep the chain alive even if a reservation rejects (it never does).
    this.chain[bucket] = run.catch(() => undefined);
    return run;
  }

  private async reserve(bucket: Bucket): Promise<void> {
    const limits = LIMITS[bucket];
    // Loop until the request fits inside both the 1s and 60s windows.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      const hits = this.hits[bucket];
      // Drop timestamps older than the widest (30-min) window.
      while (hits.length > 0 && now - hits[0] > WINDOW_30_MIN) hits.shift();

      const inLastSecond = hits.filter((t) => now - t < 1_000).length;
      const inLastMinute = hits.filter((t) => now - t < 60_000).length;
      const inLast30Min = hits.length;

      if (
        inLastSecond < limits.perSecond &&
        inLastMinute < limits.perMinute &&
        inLast30Min < limits.per30Min
      ) {
        hits.push(now);
        return;
      }

      // Compute the smallest wait that frees a slot in the breached window.
      let waitMs = 25;
      if (inLastSecond >= limits.perSecond) {
        const oldestInSecond = hits.find((t) => now - t < 1_000) ?? now;
        waitMs = Math.max(waitMs, 1_000 - (now - oldestInSecond) + 5);
      }
      if (inLastMinute >= limits.perMinute) {
        const oldestInMinute = hits.find((t) => now - t < 60_000) ?? now;
        waitMs = Math.max(waitMs, 60_000 - (now - oldestInMinute) + 5);
      }
      if (inLast30Min >= limits.per30Min) {
        waitMs = Math.max(waitMs, WINDOW_30_MIN - (now - hits[0]) + 5);
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// Process-shared singleton (per-request adapters all funnel through this).
export const upstoxRateLimiter = new UpstoxRateLimiter();
