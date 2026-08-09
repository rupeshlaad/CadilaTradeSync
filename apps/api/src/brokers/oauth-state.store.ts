/**
 * Sprint 6.1.1 — In-memory OAuth state store.
 *
 * Keyed by a random `stateId` (UUID) issued at broker-login time and
 * echoed back to the callback via an HttpOnly cookie. Fixes the
 * previous global 'current' slot which broke on concurrent OAuth
 * flows and did not preserve the originating portal URL.
 *
 * Entries expire after 15 minutes. Persistence is intentionally in
 * memory — no schema change, and the OAuth flow completes in seconds
 * so a process restart is an acceptable failure mode (broker login
 * simply has to be re-initiated by the user).
 *
 * Backward-compatible aliases (`setTradingAccountId`,
 * `getTradingAccountId`, `clearTradingAccountId`) are retained so any
 * caller still using the previous API keeps working.
 */

export interface OAuthStateEntry {
  tradingAccountId: string;
  /** Absolute or relative URL to send the browser to after callback. */
  returnTo?: string;
  createdAt: number;
}

const TTL_MS = 15 * 60 * 1000;

const stateStore = new Map<string, OAuthStateEntry>();

function purgeExpired(now: number = Date.now()) {
  for (const [k, v] of stateStore.entries()) {
    if (now - v.createdAt > TTL_MS) stateStore.delete(k);
  }
}

export function putOAuthState(
  stateId: string,
  entry: Omit<OAuthStateEntry, 'createdAt'>,
): void {
  purgeExpired();
  stateStore.set(stateId, { ...entry, createdAt: Date.now() });
}

export function takeOAuthState(
  stateId: string | undefined,
): OAuthStateEntry | undefined {
  if (!stateId) return undefined;
  purgeExpired();
  const entry = stateStore.get(stateId);
  if (!entry) return undefined;
  stateStore.delete(stateId);
  return entry;
}

// ---------------------------------------------------------------------------
// Backwards-compatible aliases (legacy API — kept so callers that only
// need the trading-account-id lookup continue to work).
// ---------------------------------------------------------------------------

export function setTradingAccountId(
  sessionId: string,
  tradingAccountId: string,
) {
  putOAuthState(sessionId, { tradingAccountId });
}

export function getTradingAccountId(sessionId: string) {
  const entry = takeOAuthState(sessionId);
  return entry?.tradingAccountId;
}

export function clearTradingAccountId(sessionId: string) {
  stateStore.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Sprint 6.2.17 — self-contained OAuth state token.
//
// The reconnect context (tradingAccountId + returnTo) is encoded into the OAuth
// `state` parameter that the broker echoes back on the callback. This makes the
// flow independent of the in-memory `stateStore` above (and of any cookie), so
// it survives hot reloads, multiple API instances and browser redirects. The
// map/cookie remain only as a backward-compatible fallback.
//
// The token is a URL-safe base64 of a tiny JSON payload. It is NOT trusted for
// authorization: `returnTo` is still open-redirect-guarded downstream, and
// `tradingAccountId` is still validated against the DB in the callback — so a
// tampered token fails safe.
// ---------------------------------------------------------------------------

export function encodeOAuthState(entry: {
  tradingAccountId?: string;
  returnTo?: string;
}): string {
  const payload = JSON.stringify({
    t: entry.tradingAccountId ?? '',
    r: entry.returnTo ?? '',
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeOAuthState(
  state: string | undefined,
): { tradingAccountId?: string; returnTo?: string } | undefined {
  if (!state) return undefined;
  try {
    const json = Buffer.from(state, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object' && obj.t) {
      return {
        tradingAccountId: String(obj.t),
        returnTo: obj.r ? String(obj.r) : undefined,
      };
    }
  } catch {
    // Not our token (e.g. a broker's default "sample_state") → fall back.
  }
  return undefined;
}
