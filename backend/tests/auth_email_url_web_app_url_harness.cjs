/**
 * Sprint 1 remediation — auth email-link base URL regression harness.
 *
 * Root cause: Sprint 1 MailService/AuthService generated verification & reset
 * links from `APP_WEB_URL`, but the existing CTS deployment convention is
 * `WEB_APP_URL` (already set on the VPS). When APP_WEB_URL was absent the code
 * silently fell back to http://localhost:3000, producing wrong links on the
 * VPS. Fix: AuthService now resolves the Web base URL via the shared
 * `webAppBaseUrl()` helper (WEB_APP_URL), the same one broker callbacks use.
 *
 * This harness proves (statically, no DB / no network / no server):
 *   1. WEB_APP_URL is authoritative for auth links.
 *   2. Trailing slash is stripped.
 *   3. APP_WEB_URL is NOT read (setting only APP_WEB_URL → localhost fallback).
 *   4. localhost is not used when WEB_APP_URL is present.
 *   5. The compiled AuthService wires the shared resolver and no longer
 *      references APP_WEB_URL.
 *
 * Run: node backend/tests/auth_email_url_web_app_url_harness.cjs   (from /app)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const apiPaths = [API_DIR, path.join(__dirname, '..', '..')];
const req = (m) => require(require.resolve(m, { paths: apiPaths }));

const REDIRECT_JS = path.join(API_DIR, 'dist', 'brokers', 'broker-callback-redirect.js');
const AUTH_SVC_JS = path.join(API_DIR, 'dist', 'auth', 'auth.service.js');

assert.ok(fs.existsSync(REDIRECT_JS), 'compiled broker-callback-redirect.js missing — run `pnpm --filter @cts/api build` first');
assert.ok(fs.existsSync(AUTH_SVC_JS), 'compiled auth.service.js missing — run build first');

const { webAppBaseUrl } = require(REDIRECT_JS);

// Same URL composition AuthService performs after resolving the base URL.
const TOKEN = 'TESTTOKEN';
const resetUrl = () => `${webAppBaseUrl()}/reset-password?token=${encodeURIComponent(TOKEN)}`;
const verifyUrl = () => `${webAppBaseUrl()}/verify-email?token=${encodeURIComponent(TOKEN)}`;

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('WEB_APP_URL is authoritative for auth links (VPS value)', () => {
  delete process.env.APP_WEB_URL;
  process.env.WEB_APP_URL = 'http://151.242.51.203:3000';
  assert.strictEqual(webAppBaseUrl(), 'http://151.242.51.203:3000');
  assert.strictEqual(resetUrl(), 'http://151.242.51.203:3000/reset-password?token=TESTTOKEN');
  assert.strictEqual(verifyUrl(), 'http://151.242.51.203:3000/verify-email?token=TESTTOKEN');
});

check('production value flows through unchanged', () => {
  process.env.WEB_APP_URL = 'https://tradesync.kamalsecurities.com';
  assert.strictEqual(resetUrl(), 'https://tradesync.kamalsecurities.com/reset-password?token=TESTTOKEN');
});

check('trailing slash is stripped', () => {
  process.env.WEB_APP_URL = 'http://151.242.51.203:3000/';
  assert.strictEqual(webAppBaseUrl(), 'http://151.242.51.203:3000');
});

check('APP_WEB_URL is NOT read (only WEB_APP_URL / localhost fallback)', () => {
  delete process.env.WEB_APP_URL;
  process.env.APP_WEB_URL = 'http://should-not-be-used:9999';
  const base = webAppBaseUrl();
  assert.notStrictEqual(base, 'http://should-not-be-used:9999', 'APP_WEB_URL must be ignored');
  assert.strictEqual(base, 'http://localhost:3000', 'must fall back to localhost when WEB_APP_URL absent');
});

check('localhost is NOT silently used when WEB_APP_URL is present', () => {
  process.env.WEB_APP_URL = 'http://151.242.51.203:3000';
  process.env.APP_WEB_URL = 'http://should-not-be-used:9999';
  assert.ok(!webAppBaseUrl().includes('localhost'));
  assert.ok(!resetUrl().includes('localhost'));
});

check('compiled AuthService wires the shared WEB_APP_URL resolver and drops APP_WEB_URL', () => {
  const src = fs.readFileSync(AUTH_SVC_JS, 'utf8');
  assert.ok(/webAppBaseUrl/.test(src), 'auth.service.js should call webAppBaseUrl()');
  assert.ok(!/APP_WEB_URL/.test(src), 'auth.service.js must not reference APP_WEB_URL anymore');
});

let passed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n      ${e.message}`);
  }
}
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
