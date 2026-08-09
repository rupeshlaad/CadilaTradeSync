/**
 * Runtime harness for the Fyers MULTI-ACCOUNT ISOLATION fix (Sprint 6.2.15).
 *
 * Reproduces the reported production bug: two Fyers master accounts (A/Dimple,
 * B/Rupesh) with DIFFERENT API Key (App ID) + Secret. Before the fix, the login
 * URL, the token exchange AND the read header all used the global
 * FYERS_APP_ID/FYERS_SECRET_ID, so reconnecting B still authenticated A.
 *
 * PostgreSQL is unavailable in this pod, so the COMPILED FyersController /
 * FyersService (apps/api/dist) are driven against an in-memory Prisma double.
 * The real `FyersController.buildAccountAdapter` + real `FyersAdapter.setCredentials`
 * run unchanged; only the SDK-touching adapter methods (getLoginUrl / exchangeToken
 * / getProfile) are patched on FyersAdapter.prototype to be deterministic and,
 * critically, to derive their result from the adapter's OWN `appId` — so any
 * env/global leakage would produce the WRONG profile and fail the assertions.
 *
 * The global env App ID is deliberately set to a THIRD value ('ENVLEAK-APP')
 * that maps to no real account; if any path fell back to env, getProfile would
 * throw "unknown app ENVLEAK-APP" and the isolation checks would fail loudly.
 */
process.env.FYERS_APP_ID = 'ENVLEAK-APP';
process.env.FYERS_SECRET_ID = 'ENVLEAK-SECRET';
process.env.FYERS_REDIRECT_URI = 'http://localhost:4000/brokers/fyers/callback';
process.env.ADMIN_APP_URL = 'http://localhost:3001';
process.env.WEB_APP_URL = 'http://localhost:3000';

const DIST = '/app/apps/api/dist';
const { FyersService } = require(`${DIST}/brokers/fyers/fyers.service.js`);
const { FyersController } = require(`${DIST}/brokers/fyers/fyers.controller.js`);
const { FyersAdapter } = require(`${DIST}/brokers/fyers/fyers.adapter.js`);
const {
  PlaceholderEncryptionService,
} = require(`${DIST}/encryption/encryption.service.js`);
const { putOAuthState, encodeOAuthState } = require(`${DIST}/brokers/oauth-state.store.js`);
const { OAUTH_STATE_COOKIE } = require(`${DIST}/brokers/oauth-cookie.js`);

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra !== undefined ? ` :: ${extra}` : ''}`);
  }
}

// App ID -> the broker user that App ID authenticates. This is the crux: the
// profile is a pure function of the adapter's OWN appId, never env/global.
const PROFILE_BY_APPID = {
  'APPID-A': { userId: 'DIMPLE-FY', userName: 'Dimple Fyers' },
  'APPID-B': { userId: 'RUPESH-FY', userName: 'Rupesh Fyers' },
};

// Patch ONLY the SDK-touching methods; setCredentials / setAccessToken and the
// constructor field wiring (this.appId/this.secretId) run for real.
FyersAdapter.prototype.getLoginUrl = function () {
  return `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${encodeURIComponent(
    this.appId,
  )}&redirect_uri=${encodeURIComponent(process.env.FYERS_REDIRECT_URI)}&response_type=code`;
};
FyersAdapter.prototype.exchangeToken = async function () {
  // Token is namespaced by the adapter's OWN app id + secret so a leak is visible.
  this.__token = `tok:${this.appId}:${this.secretId}`;
  this.setAccessToken(this.__token);
  return { access_token: this.__token, refresh_token: `refresh:${this.appId}` };
};
FyersAdapter.prototype.getProfile = async function () {
  const p = PROFILE_BY_APPID[this.appId];
  if (!p) {
    // env/global leakage lands here → hard failure, exactly what we want.
    throw new Error(`unknown app ${this.appId} (credential isolation leak)`);
  }
  return { broker: 'FYERS', ...p };
};

const enc = new PlaceholderEncryptionService();
const encCred = (v) => enc.encrypt(v); // reversible enc.v0.<base64>

const ACCOUNTS = {
  A: {
    id: 'acct-A-dimple',
    accountType: 'MASTER',
    broker: 'FYERS',
    connectionStatus: 'DISCONNECTED',
    lastHeartbeat: null,
    encryptedApiKey: encCred('APPID-A'),
    encryptedApiSecret: encCred('SECRET-A'),
  },
  B: {
    id: 'acct-B-rupesh',
    accountType: 'MASTER',
    broker: 'FYERS',
    connectionStatus: 'DISCONNECTED',
    lastHeartbeat: null,
    encryptedApiKey: encCred('APPID-B'),
    encryptedApiSecret: encCred('SECRET-B'),
  },
  // No-credentials account — must be rejected before any adapter is built.
  NOCRED: {
    id: 'acct-nocred',
    accountType: 'MASTER',
    broker: 'FYERS',
    connectionStatus: 'DISCONNECTED',
    lastHeartbeat: null,
    encryptedApiKey: null,
    encryptedApiSecret: null,
  },
  // Sprint 6.2.17 — a FOLLOWER (User Portal) account to prove portal routing.
  F: {
    id: 'acct-F-follower',
    accountType: 'FOLLOWER',
    broker: 'FYERS',
    connectionStatus: 'DISCONNECTED',
    lastHeartbeat: null,
    encryptedApiKey: encCred('APPID-A'),
    encryptedApiSecret: encCred('SECRET-A'),
  },
};

function makePrisma() {
  const byId = new Map(Object.values(ACCOUNTS).map((a) => [a.id, a]));
  const store = new Map(); // brokerSession, keyed `${accountId}|${broker}`
  const key = (w) =>
    `${w.tradingAccountId_broker.tradingAccountId}|${w.tradingAccountId_broker.broker}`;
  return {
    _sessions: store,
    _accounts: byId,
    brokerSession: {
      async upsert({ where, update, create }) {
        const k = key(where);
        const existing = store.get(k);
        if (existing) {
          for (const [f, v] of Object.entries(update)) if (v !== undefined) existing[f] = v;
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
        return store.get(key(where)) ?? null;
      },
      async deleteMany({ where }) {
        // disconnect(): remove sessions for the account
        for (const k of [...store.keys()]) {
          if (k.startsWith(`${where.tradingAccountId}|`)) store.delete(k);
        }
        return { count: 0 };
      },
    },
    tradingAccount: {
      async findUnique({ where }) {
        return byId.get(where.id) ?? null;
      },
      async update({ where, data }) {
        const acc = byId.get(where.id);
        if (!acc) {
          const e = new Error('Record to update not found.');
          e.code = 'P2025';
          throw e;
        }
        Object.assign(acc, data);
        return acc;
      },
    },
    follower: { async updateMany() { return { count: 0 }; } },
  };
}

function makeRes() {
  return {
    redirects: [],
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    redirect(url) { this.redirects.push(url); return url; },
  };
}
function makeReq(stateId) {
  return { headers: stateId ? { cookie: `${OAUTH_STATE_COOKIE}=${stateId}` } : {} };
}
function silent(ctrl) {
  ctrl.logger = { debug() {}, error() {}, log() {}, warn() {} };
  return ctrl;
}
function buildController(prisma) {
  const svc = new FyersService(prisma, enc);
  return silent(new FyersController(svc, prisma, enc));
}

async function doLogin(prisma, accountId) {
  const ctrl = buildController(prisma);
  const res = makeRes();
  await ctrl.login(accountId, undefined, res);
  return res.redirects[0];
}

async function doCallback(prisma, accountId, authCode = 'AUTHCODE') {
  const ctrl = buildController(prisma);
  const res = makeRes();
  const stateId = 'st-' + Math.random().toString(36).slice(2);
  putOAuthState(stateId, { tradingAccountId: accountId });
  await ctrl.callback(authCode, undefined, makeReq(stateId), res);
  return res.redirects[0];
}

// Sprint 6.2.17 — drive the callback with ONLY the OAuth `state` param (echoed
// by Fyers): NO cookie and NO putOAuthState → proves the reconnect context no
// longer depends on the in-memory map (hot reload / multiple instances safe).
async function doCallbackViaStateNoCookie(prisma, accountId, returnTo) {
  const ctrl = buildController(prisma);
  const res = makeRes();
  const stateToken = encodeOAuthState({ tradingAccountId: accountId, returnTo });
  await ctrl.callback('AUTHCODE', undefined, makeReq(undefined), res, stateToken);
  return res.redirects[0];
}

(async () => {
  const prisma = makePrisma();

  // ---- 1. Login URL isolation: each account's OWN App ID in the OAuth URL --
  const loginA = await doLogin(prisma, ACCOUNTS.A.id);
  const loginB = await doLogin(prisma, ACCOUNTS.B.id);
  check('login A URL carries App ID A', /client_id=APPID-A\b/.test(loginA || ''), loginA);
  check('login B URL carries App ID B', /client_id=APPID-B\b/.test(loginB || ''), loginB);
  check('login A URL does NOT carry env/global App ID', !/ENVLEAK-APP/.test(loginA || ''), loginA);
  check('login B URL does NOT carry App ID A (no crossover)', !/APPID-A\b/.test(loginB || ''), loginB);

  // ---- 2. Reported bug: connect A(Dimple), disconnect A, connect B(Rupesh) -
  let url = await doCallback(prisma, ACCOUNTS.A.id);
  check('reconnect A → success redirect', /connected=1/.test(url || ''), url);
  let sA = prisma._sessions.get(`${ACCOUNTS.A.id}|FYERS`);
  check('A session authenticated Dimple', sA && sA.userId === 'DIMPLE-FY', sA && sA.userId);

  // disconnect A (mirrors the operator flow in the bug report)
  await prisma.brokerSession.deleteMany({ where: { tradingAccountId: ACCOUNTS.A.id } });
  check('A session removed on disconnect', !prisma._sessions.get(`${ACCOUNTS.A.id}|FYERS`));

  url = await doCallback(prisma, ACCOUNTS.B.id);
  check('reconnect B → success redirect', /connected=1/.test(url || ''), url);
  let sB = prisma._sessions.get(`${ACCOUNTS.B.id}|FYERS`);
  check('B session authenticated Rupesh (NOT Dimple)', sB && sB.userId === 'RUPESH-FY', sB && sB.userId);
  check('B token derived from App ID B', sB && /tok:APPID-B:SECRET-B/.test(enc.decrypt(sB.encryptedAccessToken)), sB && sB.encryptedAccessToken);

  // ---- 3. Switch repeatedly A→B→A→B: no profile crossover ever ------------
  const seq = ['A', 'B', 'A', 'B', 'B', 'A'];
  const expected = { A: 'DIMPLE-FY', B: 'RUPESH-FY' };
  let crossover = false;
  for (const which of seq) {
    const acc = ACCOUNTS[which];
    await doCallback(prisma, acc.id);
    const s = prisma._sessions.get(`${acc.id}|FYERS`);
    if (!s || s.userId !== expected[which]) crossover = true;
    // Cross-check: the OTHER account's row must be untouched by this callback.
  }
  const finalA = prisma._sessions.get(`${ACCOUNTS.A.id}|FYERS`);
  const finalB = prisma._sessions.get(`${ACCOUNTS.B.id}|FYERS`);
  check('repeated switching: no crossover in any step', !crossover);
  check('final A row still Dimple', finalA && finalA.userId === 'DIMPLE-FY', finalA && finalA.userId);
  check('final B row still Rupesh', finalB && finalB.userId === 'RUPESH-FY', finalB && finalB.userId);
  check(
    'A and B tokens are distinct (per-account App ID/Secret)',
    finalA && finalB && enc.decrypt(finalA.encryptedAccessToken) !== enc.decrypt(finalB.encryptedAccessToken),
  );

  // ---- 4. Session isolation key = (tradingAccountId, broker) --------------
  check('two independent FYERS session rows persisted', prisma._sessions.size === 2, prisma._sessions.size);

  // ---- 5. Missing per-account credentials rejected before adapter build ---
  const loginNoCred = await doLogin(prisma, ACCOUNTS.NOCRED.id);
  check('login without API Key/Secret → error redirect', /error=/.test(loginNoCred || '') && !/connected=1/.test(loginNoCred || ''), loginNoCred);
  check('login no-cred error mentions API Key', /API%20Key|API\+Key/.test(loginNoCred || ''), loginNoCred);
  const cbNoCred = await doCallback(prisma, ACCOUNTS.NOCRED.id);
  check('callback without API Key/Secret → error redirect (no success)', /error=/.test(cbNoCred || '') && !/connected=1/.test(cbNoCred || ''), cbNoCred);
  check('no session persisted for no-cred account', !prisma._sessions.get(`${ACCOUNTS.NOCRED.id}|FYERS`));

  // ---- 6. Unknown account → clean error, no crash ------------------------
  const cbUnknown = await doCallback(prisma, 'acct-does-not-exist');
  check('callback for unknown account → error redirect', /error=/.test(cbUnknown || ''), cbUnknown);

  // ---- 7. Sprint 6.2.17: context survives via STATE PARAM (no cookie/map) --
  const uUrl = await doCallbackViaStateNoCookie(prisma, ACCOUNTS.F.id, '/dashboard/broker-accounts');
  check('state-only (no cookie, no map) recovers context → success', /connected=1/.test(uUrl || ''), uUrl);
  check('User Portal (FOLLOWER) returns to localhost:3000', (uUrl || '').startsWith('http://localhost:3000'), uUrl);
  check('User Portal returnTo preserved (/dashboard/broker-accounts)', /\/dashboard\/broker-accounts/.test(uUrl || ''), uUrl);
  check('User Portal NEVER redirected to master portal 3001', !/localhost:3001/.test(uUrl || ''), uUrl);

  const mUrl = await doCallbackViaStateNoCookie(prisma, ACCOUNTS.A.id, undefined);
  check('state-only MASTER recovers context → success', /connected=1/.test(mUrl || ''), mUrl);
  check('Master Portal returns to localhost:3001', (mUrl || '').startsWith('http://localhost:3001'), mUrl);
  check('Master Portal NEVER lands on user portal 3000', !/localhost:3000/.test(mUrl || ''), mUrl);

  // ---- 8. No state AND no cookie → unchanged missing-context fallback ------
  const noCtx = await (async () => {
    const ctrl = buildController(prisma);
    const res = makeRes();
    await ctrl.callback('AUTHCODE', undefined, makeReq(undefined), res); // no state, no cookie
    return res.redirects[0];
  })();
  check('no state + no cookie → reconnect context missing (fallback intact)',
    /Reconnect(\+|%20)context(\+|%20)missing/.test(noCtx || ''), noCtx);

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
