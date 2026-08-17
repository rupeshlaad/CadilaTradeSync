/**
 * Sprint 1 — Terms acceptance gate regression harness (static, no DB/network).
 *
 * Proves the SERVER-SIDE gate (TermsGuard):
 *   A. Verified + Terms NOT accepted (termsAcceptedAt=null) => broker/strategy
 *      operations are rejected with error code TERMS_ACCEPTANCE_REQUIRED (403).
 *   B. Verified + Terms accepted => guard allows the request (returns true).
 *   C. Direct API call without Terms is rejected (same guard, no UI involved).
 *   D. The gate is wired on the actual persistence endpoints in the compiled
 *      controllers (trading-accounts create/update/enable, strategies
 *      create/update, followers subscribe, icici connect-session) — so URL
 *      navigation cannot bypass it.
 *
 * Run: node backend/tests/terms_gate_harness.cjs   (from /app)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const DIST = path.join(API_DIR, 'dist');
const GUARD_JS = path.join(DIST, 'auth', 'guards', 'terms.guard.js');
assert.ok(fs.existsSync(GUARD_JS), 'compiled terms.guard.js missing — run `pnpm --filter @cts/api build` first');

const { TermsGuard, TERMS_ACCEPTANCE_REQUIRED } = require(GUARD_JS);
assert.strictEqual(TERMS_ACCEPTANCE_REQUIRED, 'TERMS_ACCEPTANCE_REQUIRED');

const makeCtx = (userId) => ({
  switchToHttp: () => ({ getRequest: () => ({ user: { sub: userId } }) }),
});
const makePrisma = (termsAcceptedAt) => ({
  user: { findUnique: async () => ({ termsAcceptedAt }) },
});

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('A/C. Terms NOT accepted => rejected with TERMS_ACCEPTANCE_REQUIRED', async () => {
  const guard = new TermsGuard(makePrisma(null));
  let threw = null;
  try {
    await guard.canActivate(makeCtx('user-1'));
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'must throw when termsAcceptedAt is null');
  const body = threw.getResponse ? threw.getResponse() : threw.response;
  assert.strictEqual(threw.getStatus ? threw.getStatus() : body.statusCode, 403);
  assert.strictEqual(body.error, 'TERMS_ACCEPTANCE_REQUIRED');
  assert.ok(/accept the Terms/i.test(body.message));
});

check('B. Terms accepted => guard allows request', async () => {
  const guard = new TermsGuard(makePrisma(new Date()));
  const ok = await guard.canActivate(makeCtx('user-1'));
  assert.strictEqual(ok, true);
});

check('D. gate wired on the actual persistence endpoints', () => {
  const files = {
    'trading-accounts/trading-accounts.controller.js': 3, // create, update, enable
    'strategies/strategies.controller.js': 2, // create, update
    'followers/followers.controller.js': 1, // subscribe
    'brokers/icici/icici.controller.js': 1, // connect-session
  };
  for (const [rel, minCount] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(DIST, rel), 'utf8');
    const count = (src.match(/TermsGuard/g) || []).length;
    assert.ok(
      count >= minCount,
      `${rel} should reference TermsGuard >= ${minCount} times (found ${count})`,
    );
  }
});

(async () => {
  let passed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`FAIL: ${name}\n      ${e.message}`);
    }
  }
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
})();
