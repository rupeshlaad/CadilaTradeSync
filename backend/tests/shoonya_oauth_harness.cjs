/**
 * Sprint 6.2.0 — Shoonya OAuth migration static logic harness.
 *
 * Pure-logic verification (NO real network, NO DB, NO running server): axios is
 * monkey-patched to capture requests, so this asserts the migrated adapter's
 * OAuth contract against the official Shoonya OAuth SDK/docs:
 *   - authorize URL (OAuthlogin/authorize/oauth?api_key=...&state=...)
 *   - GenAcsTok token exchange body + checksum = SHA256(apiKey+secret+code)
 *   - Bearer + jKey on authenticated reads (new NorenWClientAPI base)
 *   - "no data" empty-book handling preserved
 *   - onboarding/features migrated to OAuth
 *
 * Run: node backend/tests/shoonya_oauth_harness.cjs  (from /app)
 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

// ---- Intercept axios BEFORE loading the adapter (shared singleton) ----------
const axios = require(require.resolve('axios', {
  paths: [path.join(__dirname, '../../apps/api'), path.join(__dirname, '../..')],
}));
let captured = [];
let responder = () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: '{}' });
async function fakePost(url, body, config) {
  captured.push({ url, body, config });
  const r = responder(url, body, config);
  return { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' }, data: r.data };
}
axios.post = fakePost;
if (axios.default) axios.default.post = fakePost;

const { ShoonyaAdapter } = require(path.join(
  __dirname,
  '../../apps/api/dist/brokers/shoonya/shoonya.adapter.js',
));

const API_KEY = 'CTSKEY123';
const SECRET = 'SECR3T';
const CODE = 'v1c6d38b-7c0e-46e4-8abe';
const results = [];
const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

// 1) Authorize URL --------------------------------------------------------------
check('getLoginUrl builds OAuthlogin/authorize/oauth with api_key + state', () => {
  const a = new ShoonyaAdapter();
  a.setCredentials(`  ${API_KEY}\n`, `  ${SECRET} `); // padded → must trim
  const url = a.getLoginUrl('STATETOKEN');
  assert.ok(
    url.startsWith('https://api.shoonya.com/OAuthlogin/authorize/oauth?'),
    `base wrong: ${url}`,
  );
  const q = new URL(url).searchParams;
  assert.strictEqual(q.get('api_key'), API_KEY, 'api_key not trimmed/present');
  assert.strictEqual(q.get('state'), 'STATETOKEN', 'state not carried');
});

// 2) GenAcsTok token exchange ---------------------------------------------------
check('exchangeToken POSTs GenAcsTok with correct checksum, no Bearer, sets token', async () => {
  captured = [];
  responder = () => ({
    data: JSON.stringify({
      stat: 'Ok',
      access_token: 'ACCESS_TOK_1',
      refresh_token: 'REFRESH_1',
      expires_in: '1756990407',
      uid: 'BX4616',
      actid: 'BX4616',
      uname: 'Dimple Laad',
      email: 'x@y.com',
    }),
  });
  const a = new ShoonyaAdapter();
  a.setCredentials(API_KEY, SECRET);
  const out = await a.exchangeToken(CODE);
  const req = captured[0];
  assert.ok(req.url.endsWith('/NorenWClientAPI/GenAcsTok'), `wrong url ${req.url}`);
  assert.ok(req.body.startsWith('jData='), 'body must be jData=');
  const j = JSON.parse(req.body.slice('jData='.length));
  const expected = crypto.createHash('sha256').update(`${API_KEY}${SECRET}${CODE}`).digest('hex');
  assert.strictEqual(j.code, CODE, 'code mismatch');
  assert.strictEqual(j.checksum, expected, 'checksum must be sha256(apiKey+secret+code)');
  assert.ok(!req.body.includes('jKey='), 'GenAcsTok must NOT carry jKey');
  assert.ok(!(req.config && req.config.headers && req.config.headers.Authorization),
    'GenAcsTok must NOT send Authorization (no token yet)');
  assert.strictEqual(out.access_token, 'ACCESS_TOK_1');
  assert.strictEqual(out.userId, 'BX4616');
});

// 3) exchangeToken rejects Not_Ok ----------------------------------------------
check('exchangeToken throws broker emsg on Not_Ok', async () => {
  responder = () => ({ data: JSON.stringify({ stat: 'Not_Ok', emsg: 'Invalid Input : INVALID_VERIFIER' }) });
  const a = new ShoonyaAdapter();
  a.setCredentials(API_KEY, SECRET);
  let threw = null;
  try { await a.exchangeToken(CODE); } catch (e) { threw = e; }
  assert.ok(threw && /INVALID_VERIFIER/.test(threw.message), 'must surface broker emsg');
});

// 4) Authenticated read: Bearer + jKey on new base ------------------------------
check('getProfile hits NorenWClientAPI/UserDetails with Bearer header + jKey body', async () => {
  captured = [];
  responder = () => ({ data: JSON.stringify({ stat: 'Ok', actid: 'BX4616', uname: 'Dimple', exarr: ['NSE', 'NFO'] }) });
  const a = new ShoonyaAdapter();
  a.setSessionToken('ACCESS_TOK_1'); // as BrokerService factory does
  a.setUserId('BX4616');
  const p = await a.getProfile();
  const req = captured[0];
  assert.ok(req.url.endsWith('/NorenWClientAPI/UserDetails'), `wrong url ${req.url}`);
  assert.ok(req.body.includes('jKey=ACCESS_TOK_1'), 'jKey must be the access token');
  assert.strictEqual(req.config.headers.Authorization, 'Bearer ACCESS_TOK_1', 'Bearer header missing/wrong');
  assert.strictEqual(p.userId, 'BX4616');
  assert.deepStrictEqual(p.exchanges, ['NSE', 'NFO']);
});

// 5) validateToken probe --------------------------------------------------------
check('validateToken returns broker user id from UserDetails', async () => {
  responder = () => ({ data: JSON.stringify({ stat: 'Ok', actid: 'BX4616' }) });
  const a = new ShoonyaAdapter();
  a.setSessionToken('ACCESS_TOK_1');
  a.setUserId('BX4616');
  const v = await a.validateToken();
  assert.strictEqual(v.userId, 'BX4616');
});

// 6) empty-book handling preserved ---------------------------------------------
check('getPositions returns [] on Noren "no data" (no fabrication)', async () => {
  responder = () => ({ data: JSON.stringify({ stat: 'Not_Ok', emsg: 'Error Occurred : 5 "no data"' }) });
  const a = new ShoonyaAdapter();
  a.setSessionToken('ACCESS_TOK_1');
  a.setUserId('BX4616');
  const pos = await a.getPositions();
  assert.ok(Array.isArray(pos) && pos.length === 0, 'empty book must be []');
});

// 7) gateway 502/HTML resilience preserved -------------------------------------
check('HTML 502 gateway body → typed SHOONYA_GATEWAY_UNAVAILABLE error', async () => {
  responder = () => ({ status: 502, headers: { 'content-type': 'text/html' }, data: '<html><body>502 Bad Gateway</body></html>' });
  const a = new ShoonyaAdapter();
  a.setSessionToken('ACCESS_TOK_1');
  a.setUserId('BX4616');
  let threw = null;
  try { await a.getOrders(); } catch (e) { threw = e; }
  assert.ok(threw && threw.error_type === 'SHOONYA_GATEWAY_UNAVAILABLE', 'must raise typed gateway error');
  assert.ok(!/<html/i.test(threw.message), 'must not leak raw HTML');
});

// 8) onboarding/features migrated to OAuth -------------------------------------
check('static onboarding/features migrated to OAuth', () => {
  const o = ShoonyaAdapter.onboarding;
  assert.strictEqual(o.requiresOAuth, true, 'requiresOAuth must be true');
  assert.strictEqual(o.requiresRedirect, true, 'requiresRedirect must be true');
  assert.strictEqual(o.requiresApiKey, true, 'requiresApiKey must be true');
  assert.strictEqual(o.requiresSecret, true, 'requiresSecret must be true');
  assert.strictEqual(o.requiresPassword, false, 'password no longer required (QuickAuth removed)');
  assert.strictEqual(o.requiresTOTP, false, 'TOTP no longer required (QuickAuth removed)');
  assert.strictEqual(o.requiresVendorCode, false, 'vendor code no longer required');
  assert.strictEqual(ShoonyaAdapter.features.supportsAutoLogin, false, 'OAuth is interactive, no auto-login');
});

// 9) legacy QuickAuth login removed --------------------------------------------
check('legacy QuickAuth login() removed from adapter', () => {
  const a = new ShoonyaAdapter();
  assert.strictEqual(typeof a.login, 'undefined', 'adapter.login (QuickAuth) must be gone');
});

// ---- report ------------------------------------------------------------------
(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
      results.push([true, name]);
    } catch (e) {
      results.push([false, `${name} — ${e.message}`]);
    }
  }
  let pass = 0;
  for (const [ok, name] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass++;
  }
  console.log(`\nRESULT: ${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  process.exit(pass === results.length ? 0 : 1);
})();
