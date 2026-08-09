/**
 * Runtime harness for the Fyers OAuth reconnect fix (Sprint 6.2.13-fyers-fix).
 *
 * PostgreSQL is not available in this pod, so the compiled FyersService /
 * FyersController classes are exercised against an in-memory Prisma double that
 * reproduces Prisma semantics that matter for this bug:
 *   - upsert keyed on the (tradingAccountId, broker) compound unique key
 *   - `undefined` fields in `update` are skipped (left unchanged)
 *   - findUnique on the same compound unique key
 *
 * Verifies: callback ordering (persist -> validate -> redirect), success
 * redirect only after a passing validation, failure redirect (ok:false) with a
 * reason on validation failure, loginTime + lastHeartbeat refresh on BOTH
 * create and update.
 */
process.env.FYERS_APP_ID = process.env.FYERS_APP_ID || 'TESTAPP-100';
process.env.FYERS_SECRET_ID = process.env.FYERS_SECRET_ID || 'dummysecret';
process.env.FYERS_REDIRECT_URI =
  process.env.FYERS_REDIRECT_URI || 'http://localhost:4000/brokers/fyers/callback';
process.env.ADMIN_APP_URL = process.env.ADMIN_APP_URL || 'http://localhost:3001';

const DIST = '/app/apps/api/dist';
const { FyersService } = require(`${DIST}/brokers/fyers/fyers.service.js`);
const { FyersController } = require(`${DIST}/brokers/fyers/fyers.controller.js`);
const {
  PlaceholderEncryptionService,
} = require(`${DIST}/encryption/encryption.service.js`);
const { putOAuthState } = require(`${DIST}/brokers/oauth-state.store.js`);
const { OAUTH_STATE_COOKIE } = require(`${DIST}/brokers/oauth-cookie.js`);

let failures = 0;
const trace = [];
function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra !== undefined ? ` :: ${extra}` : ''}`);
  }
}

const ACCOUNT_ID = 'TEST_acct_fyers_1';

function makePrisma(initialSession) {
  const store = new Map();
  const account = {
    id: ACCOUNT_ID,
    accountType: 'MASTER',
    broker: 'FYERS',
    connectionStatus: 'DISCONNECTED',
    lastHeartbeat: null,
    // Sprint 6.2.15 — per-account Fyers credentials are now required by the
    // callback (decrypted → adapter.setCredentials). Placeholder encryption is
    // the reversible `enc.v0.<base64>` scheme used by PlaceholderEncryptionService.
    encryptedApiKey: 'enc.v0.' + Buffer.from('APPID-100').toString('base64'),
    encryptedApiSecret: 'enc.v0.' + Buffer.from('SECRET-xyz').toString('base64'),
  };
  if (initialSession) store.set(`${ACCOUNT_ID}|FYERS`, { ...initialSession });
  const key = (w) =>
    `${w.tradingAccountId_broker.tradingAccountId}|${w.tradingAccountId_broker.broker}`;
  return {
    _store: store,
    _account: account,
    brokerSession: {
      async upsert({ where, update, create }) {
        trace.push('brokerSession.upsert');
        const k = key(where);
        const existing = store.get(k);
        if (existing) {
          // Prisma skips `undefined` fields on update.
          for (const [f, v] of Object.entries(update)) {
            if (v !== undefined) existing[f] = v;
          }
          existing.updatedAt = new Date();
          return existing;
        }
        const row = { id: 'sess_' + k, createdAt: new Date(), updatedAt: new Date() };
        for (const [f, v] of Object.entries(create)) if (v !== undefined) row[f] = v;
        if (row.loginTime === undefined) row.loginTime = new Date();
        store.set(k, row);
        return row;
      },
      async findUnique({ where }) {
        trace.push('brokerSession.findUnique');
        return store.get(key(where)) ?? null;
      },
    },
    tradingAccount: {
      async update({ where, data }) {
        trace.push('tradingAccount.update');
        if (where.id !== account.id) {
          const e = new Error('Record to update not found.');
          e.code = 'P2025';
          throw e;
        }
        Object.assign(account, data);
        return account;
      },
      async findUnique({ where }) {
        trace.push('tradingAccount.findUnique');
        // Return the full account row (callback loads it by id for the
        // per-account credential resolution + the redirect builder reads
        // accountType off the same row).
        if (where && where.id && where.id !== account.id) return null;
        return account;
      },
    },
  };
}

function makeRes() {
  return {
    redirects: [],
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    redirect(url) {
      trace.push('res.redirect');
      this.redirects.push(url);
      return url;
    },
  };
}

function makeReq(stateId) {
  return { headers: stateId ? { cookie: `${OAUTH_STATE_COOKIE}=${stateId}` } : {} };
}

function buildController(prisma, adapterStub) {
  const enc = new PlaceholderEncryptionService();
  const svc = new FyersService(prisma, enc);
  const ctrl = new FyersController(svc, prisma, enc);
  // Sprint 6.2.15 — the controller now builds a per-account adapter internally
  // (buildAccountAdapter → new FyersAdapter().setCredentials(...)). Stub that
  // seam so the reconnect flow is exercised without the real Fyers SDK.
  ctrl.buildAccountAdapter = () => adapterStub;
  // silence Nest logger noise but keep the ordering trace
  ctrl.logger = {
    debug: (m) => trace.push(`log:${String(m).split('|')[0].trim()}`),
    error: (m) => trace.push(`err:${String(m).split('|')[0].trim()}`),
    log: () => {},
    warn: () => {},
  };
  return { ctrl, svc, enc };
}

async function runCallback({ prisma, adapter, withState = true, authCode = 'AUTHCODE123', s }) {
  const stateId = 'state-' + Math.random().toString(36).slice(2);
  if (withState) putOAuthState(stateId, { tradingAccountId: ACCOUNT_ID });
  const res = makeRes();
  await new Promise((r) => setTimeout(r, 0));
  const { ctrl } = buildController(prisma, adapter);
  await ctrl.callback(authCode, s, makeReq(withState ? stateId : undefined), res);
  return res.redirects[0];
}

const goodAdapter = {
  exchangeToken: async () => {
    trace.push('adapter.exchangeToken');
    return { access_token: 'NEWACCESSTOKEN-abc123', refresh_token: 'refresh-xyz' };
  },
  getProfile: async () => {
    trace.push('adapter.getProfile');
    return { userId: 'XY12345', userName: 'Test Fyers User' };
  },
};

(async () => {
  // ---- Scenario 1: happy path (fresh connect / create) -------------------
  trace.length = 0;
  let prisma = makePrisma(null);
  let url = await runCallback({ prisma, adapter: goodAdapter });
  console.log('  redirect:', url);
  check('S1 success redirect contains connected=1', /connected=1/.test(url || ''), url);
  check('S1 success redirect has no error param', !/[?&]error=/.test(url || ''), url);
  const s1 = prisma._store.get(`${ACCOUNT_ID}|FYERS`);
  check('S1 session row persisted', !!s1);
  check('S1 access token encrypted+stored', (s1?.encryptedAccessToken || '').startsWith('enc.v0.'), s1?.encryptedAccessToken);
  check('S1 userId persisted', s1?.userId === 'XY12345', s1?.userId);
  check('S1 loginTime set on create', s1?.loginTime instanceof Date, s1?.loginTime);
  check('S1 account CONNECTED', prisma._account.connectionStatus === 'CONNECTED');
  check('S1 lastHeartbeat set on create', prisma._account.lastHeartbeat instanceof Date);
  const iUpsert = trace.indexOf('brokerSession.upsert');
  const iFind = trace.indexOf('brokerSession.findUnique');
  const iRedirect = trace.indexOf('res.redirect');
  check(
    'S1 ORDERING persist -> validate(findUnique) -> redirect',
    iUpsert >= 0 && iFind > iUpsert && iRedirect > iFind,
    JSON.stringify(trace),
  );

  // ---- Scenario 2: reconnect over a stale row (update path) -------------
  trace.length = 0;
  const oldLogin = new Date('2020-01-01T00:00:00.000Z');
  prisma = makePrisma({
    id: 'sess_old',
    tradingAccountId: ACCOUNT_ID,
    broker: 'FYERS',
    encryptedAccessToken: 'enc.v0.' + Buffer.from('STALE-TOKEN').toString('base64'),
    userId: 'OLDUSER',
    userName: 'Old Name',
    loginTime: oldLogin,
    createdAt: oldLogin,
  });
  url = await runCallback({ prisma, adapter: goodAdapter });
  console.log('  redirect:', url);
  const s2 = prisma._store.get(`${ACCOUNT_ID}|FYERS`);
  const decoded = Buffer.from(String(s2.encryptedAccessToken).replace('enc.v0.', ''), 'base64').toString('utf8');
  check('S2 success redirect', /connected=1/.test(url || ''), url);
  check('S2 token overwritten with new token', decoded === 'NEWACCESSTOKEN-abc123', decoded);
  check('S2 userId refreshed on update', s2.userId === 'XY12345', s2.userId);
  check('S2 userName refreshed on update', s2.userName === 'Test Fyers User', s2.userName);
  check('S2 loginTime REFRESHED on update', s2.loginTime.getTime() > oldLogin.getTime(), s2.loginTime);
  check('S2 lastHeartbeat refreshed on update', prisma._account.lastHeartbeat instanceof Date);
  check('S2 row identity preserved (upsert not duplicate)', s2.id === 'sess_old', s2.id);

  // ---- Scenario 3: profile without userId -> validation must FAIL -------
  trace.length = 0;
  prisma = makePrisma(null);
  url = await runCallback({
    prisma,
    adapter: {
      exchangeToken: async () => ({ access_token: 'TOKEN-ok' }),
      getProfile: async () => ({}),
    },
  });
  console.log('  redirect:', url);
  check('S3 failure redirect (no connected=1)', !/connected=1/.test(url || ''), url);
  check('S3 error mentions API ID', /API%20ID|API\+ID|API ID/.test(url || ''), url);
  check('S3 error prefixed "Fyers reconnect failed"', /Fyers\+reconnect\+failed|Fyers%20reconnect%20failed/.test(url || ''), url);

  // ---- Scenario 4: empty access token -> validation must FAIL ----------
  trace.length = 0;
  prisma = makePrisma(null);
  url = await runCallback({
    prisma,
    adapter: {
      exchangeToken: async () => ({ access_token: '' }),
      getProfile: async () => ({ userId: 'XY12345', userName: 'N' }),
    },
  });
  console.log('  redirect:', url);
  check('S4 failure redirect on empty access token', !/connected=1/.test(url || '') && /error=/.test(url || ''), url);

  // ---- Scenario 5: missing auth_code -> failure redirect, no persist ----
  trace.length = 0;
  prisma = makePrisma(null);
  // `null` (not undefined) so the harness default does not re-apply; the real
  // controller receives `undefined` from Express for a missing query param and
  // both hit the same `!authCode` guard.
  url = await runCallback({ prisma, adapter: goodAdapter, authCode: null });
  console.log('  redirect:', url);
  check('S5 failure redirect on missing auth code', /error=Missing/.test(url || ''), url);
  check('S5 nothing persisted', prisma._store.size === 0);

  // ---- Scenario 6: missing state cookie -> failure redirect -------------
  trace.length = 0;
  prisma = makePrisma(null);
  url = await runCallback({ prisma, adapter: goodAdapter, withState: false });
  console.log('  redirect:', url);
  check('S6 failure redirect on missing reconnect context', /error=Reconnect/.test(url || ''), url);
  check('S6 nothing persisted', prisma._store.size === 0);

  // ---- Scenario 7: broker returns s != ok ------------------------------
  trace.length = 0;
  prisma = makePrisma(null);
  url = await runCallback({ prisma, adapter: goodAdapter, s: 'error' });
  console.log('  redirect:', url);
  check('S7 failure redirect on broker status param', /error=Broker/.test(url || ''), url);

  // ---- Scenario 8: exchangeToken throws -------------------------------
  trace.length = 0;
  prisma = makePrisma(null);
  url = await runCallback({
    prisma,
    adapter: {
      exchangeToken: async () => {
        throw new Error('invalid auth code');
      },
      getProfile: async () => ({}),
    },
  });
  console.log('  redirect:', url);
  check('S8 failure redirect on token exchange error', /error=invalid/.test(url || ''), url);
  check('S8 nothing persisted', prisma._store.size === 0);

  // ---- Scenario 9: validatePersistedSession unit checks ----------------
  prisma = makePrisma(null);
  const { svc } = buildController(prisma, goodAdapter);
  let v = await svc.validatePersistedSession(ACCOUNT_ID);
  check('S9 no row -> ok:false', v.ok === false && /No persisted/.test(v.reason), JSON.stringify(v));

  await svc.saveSession(ACCOUNT_ID, { access_token: 'TK' }, { userId: 'U1', userName: 'N1' });
  v = await svc.validatePersistedSession(ACCOUNT_ID);
  check('S9 valid row -> ok:true with userId', v.ok === true && v.userId === 'U1', JSON.stringify(v));

  // wrong-account lookup must not return another account's row
  v = await svc.validatePersistedSession('TEST_other_acct');
  check('S9 other account -> ok:false', v.ok === false, JSON.stringify(v));

  // ---- Scenario 10: persistence failure (tradingAccount missing) -------
  trace.length = 0;
  prisma = makePrisma(null);
  prisma._account.id = 'different-id';
  url = await runCallback({ prisma, adapter: goodAdapter });
  console.log('  redirect:', url);
  check('S10 no success redirect when heartbeat update throws', !/connected=1/.test(url || ''), url);

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
