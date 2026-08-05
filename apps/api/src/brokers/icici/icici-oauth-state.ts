import type Redis from 'ioredis';

/**
 * Sprint 6.2.0 Hotfix — durable OAuth state for the ICICI Direct (Breeze)
 * login flow.
 *
 * The shared in-memory OAuth state map (oauth-state.store.ts) is lost whenever
 * the API process restarts or when more than one replica is running. Breeze's
 * interactive login (client id + password + OTP) commonly takes a minute or
 * more, and the callback arrives as a *separate* cross-site POST — so the
 * in-memory entry created at /login is frequently gone by the time /callback
 * runs, producing "Reconnect context missing".
 *
 * This helper persists the same `{ tradingAccountId, returnTo }` context in
 * Redis (already provisioned in the CTS stack) keyed by the OAuth state id, so
 * it survives restarts and is shared across replicas. It is deliberately
 * ICICI-scoped and best-effort (every call is guarded) so it never affects the
 * other brokers and degrades gracefully to the in-memory store when Redis is
 * unavailable. The entry is NOT deleted on read (TTL handles cleanup) so a
 * GET+POST double callback both resolve the context.
 */

const PREFIX = 'icici:oauth:';
const TTL_SECONDS = 15 * 60;

export interface ICICIOAuthState {
  tradingAccountId: string;
  returnTo?: string;
}

export async function putICICIState(
  redis: Redis | undefined,
  stateId: string,
  entry: ICICIOAuthState,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(PREFIX + stateId, JSON.stringify(entry), 'EX', TTL_SECONDS);
  } catch {
    /* best-effort — the in-memory store remains as a same-process fallback */
  }
}

export async function readICICIState(
  redis: Redis | undefined,
  stateId: string | undefined,
): Promise<ICICIOAuthState | undefined> {
  if (!redis || !stateId) return undefined;
  try {
    const raw = await redis.get(PREFIX + stateId);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.tradingAccountId === 'string') {
      return parsed as ICICIOAuthState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
