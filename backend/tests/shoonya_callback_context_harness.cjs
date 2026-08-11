/**
 * Shoonya OAuth callback reconnect-context recovery — regression harness.
 *
 * Bug: Shoonya does NOT echo the OAuth `state` param, so the callback fell back
 * to a random-id cookie -> in-memory stateStore map that is not shared across
 * API instances / restarts -> context lost -> "Reconnect context missing".
 * Fix: the cookie now carries the SELF-CONTAINED encoded state token, so the
 * callback recovers context from `state` param OR the cookie with no server
 * memory dependency and no need for the broker to echo `state`.
 *
 * Pure logic (no DB/server/network): uses the REAL compiled oauth-state.store
 * and oauth-cookie helpers, plus static assertions on the compiled controllers.
 *
 * Run: node backend/tests/shoonya_callback_context_harness.cjs   (from /app)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const API_DIST = path.join(__dirname, '..', '..', 'apps', 'api', 'dist');
const store = require(path.join(API_DIST, 'brokers', 'oauth-state.store.js'));
const cookie = require(path.join(API_DIST, 'brokers', 'oauth-cookie.js'));
const { encodeOAuthState, decodeOAuthState, takeOAuthState } = store;
const { setOAuthStateCookie, readCookie, OAUTH_STATE_COOKIE } = cookie;

const USER_ACCT = 'acct-user-123';
const MASTER_ACCT = 'acct-master-987';
const RETURN_TO = '/dashboard/broker-accounts';

// Simulate the browser cookie jar round trip via the real helpers.
function setCookieAndReadBack(token) {
  let header;
  const res = { setHeader: (_k, v) => { header = Array.isArray(v) ? v.join('; ') : String(v); } };
  setOAuthStateCookie(res, token);
  // Browser sends back only name=value (first segment).
  const nameValue = header.split(';')[0];
  const req = { headers: { cookie: nameValue } };
  return readCookie(req, OAUTH_STATE_COOKIE);
}

// Mirror the controller's recovery expression exactly.
function recover(stateParam, req) {
  const entry =
    decodeOAuthState(stateParam) ??
    decodeOAuthState(readCookie(req, OAUTH_STATE_COOKIE));
  return { tradingAccountId: entry?.tradingAccountId, returnTo: entry?.returnTo };
}

const results = [];
const check = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} — ${e.message}`]); } };

// 1) Shoonya USER PORTAL — no state echoed, self-contained cookie recovers it.
check('Shoonya User flow: no state param, cookie carries context → recovered', () => {
  const token = encodeOAuthState({ tradingAccountId: USER_ACCT, returnTo: RETURN_TO });
  const jarValue = setCookieAndReadBack(token);
  const req = { headers: { cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(jarValue)}` } };
  const ctx = recover(undefined, req);
  assert.strictEqual(ctx.tradingAccountId, USER_ACCT);
  assert.strictEqual(ctx.returnTo, RETURN_TO);
});

// 2) Shoonya MASTER ACCOUNT — identical durable path.
check('Shoonya Master flow: no state param, cookie carries context → recovered', () => {
  const token = encodeOAuthState({ tradingAccountId: MASTER_ACCT });
  const req = { headers: { cookie: `${OAUTH_STATE_COOKIE}=${encodeURIComponent(setCookieAndReadBack(token))}` } };
  const ctx = recover(undefined, req);
  assert.strictEqual(ctx.tradingAccountId, MASTER_ACCT);
});

// 3) Fyers/Upstox unaffected — state param present is used first.
check('Fyers/Upstox flow: state param echoed → recovered from param (unaffected)', () => {
  const token = encodeOAuthState({ tradingAccountId: 'acct-fyers-1', returnTo: '/x' });
  // Even with an empty/garbage cookie, the state param wins.
  const req = { headers: { cookie: '' } };
  const ctx = recover(token, req);
  assert.strictEqual(ctx.tradingAccountId, 'acct-fyers-1');
  assert.strictEqual(ctx.returnTo, '/x');
});

// 4) OLD-bug reproduction — random-id cookie + empty (other-instance) map → lost.
check('OLD behaviour reproduced: random-id cookie + empty map → context lost (the bug)', () => {
  const randomStateId = 'b1c2d3e4-0000-1111-2222-333344445555';
  // Different instance / after restart: this id was never put into THIS map.
  const cookieEntry = takeOAuthState(randomStateId);
  assert.strictEqual(cookieEntry, undefined, 'stale map lookup must miss (proves why it broke)');
  // And a random UUID is not a decodable self-contained token either.
  assert.strictEqual(decodeOAuthState(randomStateId), undefined);
});

// 5) Cookie round-trips the base64url token intact.
check('Cookie round-trips base64url token intact', () => {
  const token = encodeOAuthState({ tradingAccountId: 'acct-_-A9', returnTo: '/dashboard?tab=a&b=c' });
  const back = setCookieAndReadBack(token);
  assert.strictEqual(back, token, 'cookie value must survive encode/decodeURIComponent');
  const decoded = decodeOAuthState(back);
  assert.strictEqual(decoded.tradingAccountId, 'acct-_-A9');
  assert.strictEqual(decoded.returnTo, '/dashboard?tab=a&b=c');
});

// 6) Fail-safe: garbage/tampered cookie → undefined (controller shows error, no crash).
check('Fail-safe: tampered cookie decodes to undefined (fails safe)', () => {
  const req = { headers: { cookie: `${OAUTH_STATE_COOKIE}=not-a-valid-token` } };
  const ctx = recover(undefined, req);
  assert.strictEqual(ctx.tradingAccountId, undefined);
});

// 7) Security posture: cookie is HttpOnly + SameSite=Lax (+Secure in prod).
check('Cookie remains HttpOnly + SameSite=Lax (CSRF posture preserved)', () => {
  let header;
  setOAuthStateCookie({ setHeader: (_k, v) => { header = Array.isArray(v) ? v.join('; ') : String(v); } }, 'tok');
  assert.ok(/HttpOnly/.test(header), 'must stay HttpOnly');
  assert.ok(/SameSite=Lax/.test(header), 'must stay SameSite=Lax');
  assert.ok(/Path=\//.test(header), 'must be Path=/');
});

// ---- Static guards on compiled controllers ----------------------------------
const shoonyaCtrl = fs.readFileSync(path.join(API_DIST, 'brokers', 'shoonya', 'shoonya.controller.js'), 'utf8');
const fyersCtrl = fs.readFileSync(path.join(API_DIST, 'brokers', 'fyers', 'fyers.controller.js'), 'utf8');
const upstoxCtrl = fs.readFileSync(path.join(API_DIST, 'brokers', 'upstox', 'upstox.controller.js'), 'utf8');

check('Shoonya controller no longer uses the in-memory state map', () => {
  assert.ok(!/takeOAuthState/.test(shoonyaCtrl), 'must not call takeOAuthState');
  assert.ok(!/putOAuthState/.test(shoonyaCtrl), 'must not call putOAuthState');
  assert.ok(/setOAuthStateCookie\)\(res, stateToken\)/.test(shoonyaCtrl), 'cookie must carry the self-contained token');
});
check('Shoonya callback still validates tradingAccountId against the DB (unchanged guard)', () => {
  assert.ok(/findUnique/.test(shoonyaCtrl), 'callback still loads the account from DB');
  assert.ok(/Reconnect context missing/.test(shoonyaCtrl), 'guard message still present for genuinely-missing context');
});
check('Fyers & Upstox controllers untouched (still use state param + map)', () => {
  assert.ok(/takeOAuthState/.test(fyersCtrl), 'Fyers controller unchanged');
  assert.ok(/takeOAuthState/.test(upstoxCtrl), 'Upstox controller unchanged');
});

(() => {
  let pass = 0;
  for (const [ok, name] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`\nRESULT: ${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  process.exit(pass === results.length ? 0 : 1);
})();
