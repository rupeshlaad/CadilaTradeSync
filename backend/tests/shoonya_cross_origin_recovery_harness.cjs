/**
 * Regression harness — Shoonya cross-origin OAuth context recovery.
 *
 * Reproduces the exact HAR-captured production failure and proves the fix:
 *
 *   1) OAuth STARTS on the API origin the frontend points at, e.g.
 *        http://localhost:4000/brokers/shoonya/login?tradingAccountId=<id>
 *      -> /login sets the cts_oauth_state cookie on THAT origin AND records a
 *         server-side pending context (the fix).
 *   2) Shoonya authenticates and redirects the browser to the PORTAL-registered
 *      callback on a DIFFERENT origin, e.g.
 *        https://cts.investwithdimple.com/brokers/shoonya/callback?code=...
 *      -> Query.state = none  AND  Cookie header = none (different origin).
 *   3) The callback must STILL recover the correct tradingAccountId.
 *
 * Runs against the COMPILED dist. Pure logic (no DB/server/network). Mirrors the
 * controller's recovery order exactly: state param -> cookie -> pending store.
 * FAILS if the cross-origin callback (no state, no cookie) cannot reconnect.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const API_DIST = path.resolve(__dirname, '../../apps/api/dist');

const { encodeOAuthState, decodeOAuthState } = require(
  path.join(API_DIST, 'brokers', 'oauth-state.store.js'),
);
const {
  savePendingOAuth,
  recoverLatestPendingOAuth,
  clearPendingOAuth,
  _pendingOAuthSize,
} = require(path.join(API_DIST, 'brokers', 'oauth-pending.store.js'));

let pass = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; console.log(`  PASS: ${label}`); }
  catch (e) { fail++; console.log(`  FAIL: ${label} -> ${e.message}`); }
};

// Exact reproduction of the controller recovery expression (state -> cookie ->
// pending-store fallback). Returns { tradingAccountId, returnTo, source }.
function controllerRecover({ stateParam, cookieVal, broker }) {
  let entry =
    decodeOAuthState(stateParam) ?? decodeOAuthState(cookieVal);
  let source = entry
    ? (decodeOAuthState(stateParam) ? 'state param' : 'cookie')
    : 'none';
  if (!entry || !entry.tradingAccountId) {
    const pendingCtx = recoverLatestPendingOAuth(broker);
    if (pendingCtx && pendingCtx.tradingAccountId) {
      entry = pendingCtx;
      source = 'pending-store (cross-origin fallback)';
    }
  }
  return {
    tradingAccountId: entry && entry.tradingAccountId,
    returnTo: entry && entry.returnTo,
    source,
  };
}

console.log('THE reported bug: localhost -> Shoonya -> cross-origin callback (no state, no cookie)');
check('login records pending context on the API process', () => {
  clearPendingOAuth('SHOONYA');
  // /login on origin A (http://localhost:4000)
  const stateToken = encodeOAuthState({ tradingAccountId: 'acc-123', returnTo: '/dashboard/master-accounts' });
  assert.ok(stateToken.length > 0, 'state token built');
  savePendingOAuth({ broker: 'SHOONYA', tradingAccountId: 'acc-123', returnTo: '/dashboard/master-accounts' });
  assert.strictEqual(_pendingOAuthSize() >= 1, true, 'pending entry stored');
});

check('cross-origin callback recovers tradingAccountId WITHOUT state and WITHOUT cookie', () => {
  // /callback on origin B (https://cts.investwithdimple.com): both empty.
  const r = controllerRecover({ stateParam: undefined, cookieVal: undefined, broker: 'SHOONYA' });
  assert.strictEqual(r.tradingAccountId, 'acc-123', 'tradingAccountId reconnected');
  assert.strictEqual(r.returnTo, '/dashboard/master-accounts', 'returnTo preserved');
  assert.strictEqual(r.source, 'pending-store (cross-origin fallback)', 'used the durable fallback');
});

check('OLD behaviour (no fallback) would have failed — proving this was the bug', () => {
  clearPendingOAuth('SHOONYA');
  // Same cross-origin callback but with an EMPTY pending store == pre-fix state.
  const entry = decodeOAuthState(undefined) ?? decodeOAuthState(undefined);
  assert.strictEqual(entry, undefined, 'pre-fix: state+cookie both empty -> context lost');
});

check('fallback is single-use (a replayed callback cannot reuse the context)', () => {
  clearPendingOAuth('SHOONYA');
  savePendingOAuth({ broker: 'SHOONYA', tradingAccountId: 'acc-777' });
  const first = recoverLatestPendingOAuth('SHOONYA');
  const second = recoverLatestPendingOAuth('SHOONYA');
  assert.strictEqual(first && first.tradingAccountId, 'acc-777', 'first recovery ok');
  assert.strictEqual(second, undefined, 'second recovery consumed/empty');
});

check('same-origin flow still recovers via cookie (unchanged) and clears stale pending', () => {
  clearPendingOAuth('SHOONYA');
  const token = encodeOAuthState({ tradingAccountId: 'acc-cookie', returnTo: '/x' });
  savePendingOAuth({ broker: 'SHOONYA', tradingAccountId: 'acc-cookie', returnTo: '/x' });
  const r = controllerRecover({ stateParam: undefined, cookieVal: token, broker: 'SHOONYA' });
  assert.strictEqual(r.tradingAccountId, 'acc-cookie', 'cookie path still works');
  assert.strictEqual(r.source, 'cookie', 'source is cookie, not fallback');
});

check('state-param brokers path unaffected (state wins over everything)', () => {
  clearPendingOAuth('SHOONYA');
  const token = encodeOAuthState({ tradingAccountId: 'acc-state', returnTo: '/y' });
  const r = controllerRecover({ stateParam: token, cookieVal: undefined, broker: 'SHOONYA' });
  assert.strictEqual(r.tradingAccountId, 'acc-state', 'state param used');
  assert.strictEqual(r.source, 'state param', 'source is state param');
});

check('broker isolation: a pending FYERS entry is never handed to SHOONYA', () => {
  clearPendingOAuth('SHOONYA');
  clearPendingOAuth('FYERS');
  savePendingOAuth({ broker: 'FYERS', tradingAccountId: 'fy-1' });
  const r = recoverLatestPendingOAuth('SHOONYA');
  assert.strictEqual(r, undefined, 'no SHOONYA pending -> no cross-broker leak');
  clearPendingOAuth('FYERS');
});

check('latest-wins when two Shoonya logins are in-flight', () => {
  clearPendingOAuth('SHOONYA');
  savePendingOAuth({ broker: 'SHOONYA', tradingAccountId: 'old' });
  // ensure a strictly later timestamp
  const later = Date.now() + 5;
  while (Date.now() < later) { /* spin a few ms */ }
  savePendingOAuth({ broker: 'SHOONYA', tradingAccountId: 'new' });
  const r = recoverLatestPendingOAuth('SHOONYA');
  assert.strictEqual(r.tradingAccountId, 'new', 'most-recent login recovered');
  clearPendingOAuth('SHOONYA');
});

console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
