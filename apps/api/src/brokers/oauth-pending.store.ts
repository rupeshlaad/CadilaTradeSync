/**
 * Sprint 6.2.x — Cross-origin-safe in-flight OAuth context recovery.
 *
 * PROBLEM (proven by HAR capture):
 *   Shoonya's OAuth is INITIATED on the API origin the frontend points at
 *   (NEXT_PUBLIC_API_URL, e.g. http://localhost:4000/brokers/shoonya/login),
 *   but Shoonya redirects the browser to the PORTAL-registered callback origin
 *   (e.g. https://cts.investwithdimple.com/brokers/shoonya/callback?code=...).
 *   Those are DIFFERENT origins, so:
 *     - the host-scoped `cts_oauth_state` cookie set at /login is NOT sent to
 *       the callback origin, and
 *     - Shoonya does NOT echo the `state` parameter.
 *   Both existing recovery channels are therefore empty at the callback and the
 *   originating `tradingAccountId` is lost ("Reconnect context missing").
 *
 * FIX:
 *   Keep the reconnect context on the API PROCESS itself. A cross-origin browser
 *   redirect does not change which API instance serves the callback, so a
 *   server-side entry survives the redirect without any cookie or `state` param.
 *   Recovery is single-flight per broker: the callback takes the most-recent
 *   un-consumed pending entry for that broker within a short TTL (single-use).
 *
 * SCOPE:
 *   Used ONLY as a last-resort fallback by the Shoonya controller (after the
 *   `state` param and the cookie are both tried). Other brokers (Fyers / Upstox
 *   / Zerodha) recover via the echoed `state` param and are untouched. No DB
 *   schema change. Deliberately in-memory — consistent with the existing
 *   `oauth-state.store` and adequate because the flow completes in seconds and
 *   the API runs as a single instance; a process restart simply requires the
 *   user to re-initiate the (few-second) login.
 */

export interface PendingOAuthContext {
  broker: string;
  tradingAccountId: string;
  returnTo?: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, PendingOAuthContext>();

function purgeExpired(now: number = Date.now()): void {
  for (const [key, value] of pending.entries()) {
    if (now - value.createdAt > TTL_MS) pending.delete(key);
  }
}

/**
 * Record an in-flight OAuth context at /login. Returns the internal id (opaque;
 * callers do not need it — recovery is by broker).
 */
export function savePendingOAuth(entry: {
  broker: string;
  tradingAccountId: string;
  returnTo?: string;
}): string {
  purgeExpired();
  const id = `${entry.broker}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  pending.set(id, {
    broker: entry.broker,
    tradingAccountId: entry.tradingAccountId,
    returnTo: entry.returnTo,
    createdAt: Date.now(),
  });
  return id;
}

/**
 * Recover (and consume) the most-recent un-expired pending context for a broker.
 * Single-use: the entry is removed so a second callback cannot reuse it.
 */
export function recoverLatestPendingOAuth(
  broker: string,
): { tradingAccountId: string; returnTo?: string } | undefined {
  purgeExpired();
  let latestKey: string | undefined;
  let latest: PendingOAuthContext | undefined;
  for (const [key, value] of pending.entries()) {
    if (value.broker !== broker) continue;
    if (!latest || value.createdAt > latest.createdAt) {
      latest = value;
      latestKey = key;
    }
  }
  if (!latest || !latestKey) return undefined;
  pending.delete(latestKey);
  return { tradingAccountId: latest.tradingAccountId, returnTo: latest.returnTo };
}

/** Drop all pending entries for a broker (used after a same-origin success). */
export function clearPendingOAuth(broker: string): void {
  for (const [key, value] of pending.entries()) {
    if (value.broker === broker) pending.delete(key);
  }
}

/** Test-only: current number of pending entries. */
export function _pendingOAuthSize(): number {
  return pending.size;
}
