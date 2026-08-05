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
