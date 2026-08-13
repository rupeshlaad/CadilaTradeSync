/**
 * Regression harness for the Fyers PLACEMENT credential-isolation fix.
 *
 * Bug: every Fyers ORDER PLACEMENT path (ManualTradeService, OrderActionsService,
 * CopyTradingService, PositionSynchronizationService) built `new FyersAdapter()`
 * and called only setAccessToken() — so the authenticated header `appId:token`
 * used the global env FYERS_APP_ID (absent on the box → blank App ID), while the
 * token had been minted under the account's OWN App ID during OAuth. Fyers
 * rejected the order with code -50 "Algo orders are not allowed from this app".
 *
 * Fix: each placement path now loads the TradingAccount, decrypts its App ID +
 * Secret and calls adapter.setCredentials(appId, secret) + setAccessToken(token)
 * before placeOrder() — identical to the OAuth controller and broker.service.
 *
 * PostgreSQL / a live Fyers session are unavailable in this pod, so the COMPILED
 * services (apps/api/dist) run for real against in-memory Prisma / Encryption
 * doubles; only the SDK-touching fyers-api-v3 methods are patched to no-op.
 *
 * The global env App ID is set to a LEAK SENTINEL that maps to no account; if
 * any path fell back to env the assertions on the recorded App ID would fail.
 *
 * Proves:
 *   1. multiple Fyers accounts with DIFFERENT App IDs place independently;
 *   2. NO FYERS_APP_ID / FYERS_SECRET_ID is required in .env;
 *   3. diagnostics now log the correct App ID instead of "(none)";
 *   4. every placement path binds per-account credentials (structural guard),
 *      and OAuth/reconnect/account-isolation harnesses remain green (run
 *      separately).
 */
const fs = require('node:fs');
const path = require('node:path');

// Env: a sentinel App ID/Secret that belongs to NO account. Any env leak shows.
process.env.FYERS_APP_ID = 'ENVLEAK-APP';
process.env.FYERS_SECRET_ID = 'ENVLEAK-SECRET';
process.env.FYERS_REDIRECT_URI = 'https://cts.investwithdimple.com/api/brokers/fyers/callback';
process.env.NODE_ENV = 'test';

const DIST = '/app/apps/api/dist';
const { FyersAdapter } = require(`${DIST}/brokers/fyers/fyers.adapter.js`);
const { PlaceholderEncryptionService } = require(`${DIST}/encryption/encryption.service.js`);
const { ManualTradeService } = require(`${DIST}/manual-trading/manual-trade.service.js`);
const { OrderActionsService } = require(`${DIST}/order-actions/order-actions.service.js`);

// Patch the fyers-api-v3 SDK so nothing hits the network. The compiled adapter
// does `new fyers_api_v3_1.fyersModel()` (property read at call time), so
// swapping the exported class makes every adapter instance use the stub.
// setCredentials / setAccessToken and the adapter field wiring still run for real.
const sdkPath = require.resolve('fyers-api-v3', {
  paths: ['/app/apps/api/node_modules', '/app/node_modules'],
});
const sdk = require(sdkPath);
class FyersStub {
  setAppId(id) { this.appId = id; }
  setRedirectUrl() {}
  setAccessToken() {}
  async place_order() { return { s: 'ok', code: 1101, message: 'stub', id: '25081100000123' }; }
  async modify_order() { return { s: 'ok', id: 'm-1' }; }
  async cancel_order() { return { s: 'ok', id: 'c-1' }; }
  async get_orders() { return { s: 'ok', orderBook: [] }; }
}
sdk.fyersModel = FyersStub;

// Record every setCredentials call (then run the real implementation).
const credCalls = [];
const realSetCredentials = FyersAdapter.prototype.setCredentials;
FyersAdapter.prototype.setCredentials = function (appId, secretId) {
  credCalls.push({ appId, secretId });
  return realSetCredentials.call(this, appId, secretId);
};

const enc = new PlaceholderEncryptionService();
const encv = (v) => enc.encrypt(v);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${extra !== undefined ? ` :: ${extra}` : ''}`); }
}
function captureLogs(fn) {
  const chunks = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  return Promise.resolve().then(fn).then(
    (v) => { process.stdout.write = o; process.stderr.write = e; return { v, logs: chunks.join('') }; },
    (err) => { process.stdout.write = o; process.stderr.write = e; return { err, logs: chunks.join('') }; },
  );
}

const ACCOUNTS = {
  A: { id: 'acct-A', broker: 'FYERS', encryptedApiKey: encv('APPID-A'), encryptedApiSecret: encv('SECRET-A') },
  B: { id: 'acct-B', broker: 'FYERS', encryptedApiKey: encv('APPID-B'), encryptedApiSecret: encv('SECRET-B') },
};

// In-memory Prisma double: tradingAccount + brokerSession lookups only.
function makePrisma() {
  const byId = new Map(Object.values(ACCOUNTS).map((a) => [a.id, a]));
  const session = (accId) => ({
    tradingAccountId: accId,
    broker: 'FYERS',
    userId: accId === 'acct-A' ? 'DIMPLE-FY' : 'RUPESH-FY',
    encryptedAccessToken: encv(`token-for-${accId}`),
    expiresAt: new Date('2026-08-12T23:59:59.000Z'),
  });
  return {
    tradingAccount: { async findUnique({ where }) { return byId.get(where.id) ?? null; } },
    brokerSession: { async findFirst({ where }) { return byId.has(where.tradingAccountId) ? session(where.tradingAccountId) : null; } },
  };
}

(async () => {
  // ======================================================================
  // PART 1 — Adapter behaviour: no env, per-account App ID, diagnostics.
  // ======================================================================
  // "No FYERS_APP_ID required": with the env vars removed, a bare adapter has
  // NO App ID (it is not hardcoded and not required from .env). Placement paths
  // supply it via setCredentials (below). Restore the leak sentinel afterwards
  // so the rest of the suite proves env is never used even when present.
  const savedAppId = process.env.FYERS_APP_ID;
  const savedSecret = process.env.FYERS_SECRET_ID;
  delete process.env.FYERS_APP_ID;
  delete process.env.FYERS_SECRET_ID;
  const noEnvAdapter = new FyersAdapter();
  check('1. no FYERS_APP_ID in .env → bare adapter App ID is blank (none hardcoded)', noEnvAdapter.appId === '', `appId='${noEnvAdapter.appId}'`);
  process.env.FYERS_APP_ID = savedAppId;
  process.env.FYERS_SECRET_ID = savedSecret;

  const order = { symbol: 'NSE:SBIN-EQ', qty: 1, type: 2, side: 1, productType: 'INTRADAY', limitPrice: 0, stopPrice: 0, disclosedQty: 0, validity: 'DAY', offlineOrder: false };

  const adA = new FyersAdapter();
  adA.setCredentials('APPID-A', 'SECRET-A');
  adA.setAccessToken('token-A');
  const rA = await captureLogs(() => adA.placeOrder(order));
  check('1. account A diagnostics log its OWN App ID', rA.logs.includes('App ID being used    : APPID-A'), 'App ID line missing/wrong');
  check('1. account A App ID is NOT "(none)"', !rA.logs.includes('App ID being used    : (none)'));
  check('1. account A App ID is NOT the env sentinel', !rA.logs.includes('ENVLEAK-APP'));

  const adB = new FyersAdapter();
  adB.setCredentials('APPID-B', 'SECRET-B');
  adB.setAccessToken('token-B');
  const rB = await captureLogs(() => adB.placeOrder(order));
  check('1. account B diagnostics log its OWN App ID', rB.logs.includes('App ID being used    : APPID-B'));
  check('1. A and B are independent (no crossover)', !rB.logs.includes('APPID-A') && !rA.logs.includes('APPID-B'));

  // ======================================================================
  // PART 2 — ManualTradeService.placeOnMaster binds per-account credentials.
  // ======================================================================
  const mts = new ManualTradeService(makePrisma(), enc, null, null, null, null);
  const dto = { symbol: 'NSE:SBIN-EQ', exchange: 'NSE', side: 'BUY', orderType: 'MARKET', quantity: 1, price: null, triggerPrice: null, validity: 'DAY', product: 'INTRADAY' };

  credCalls.length = 0;
  const mA = await captureLogs(() => mts.placeOnMaster('acct-A', 'FYERS', dto));
  check('2. ManualTrade(A) placed (brokerOrderId extracted)', mA.v && mA.v.brokerOrderId === '25081100000123', JSON.stringify(mA.v || mA.err));
  check('2. ManualTrade(A) called setCredentials with account A App ID', credCalls.some((c) => c.appId === 'APPID-A' && c.secretId === 'SECRET-A'), JSON.stringify(credCalls));
  check('2. ManualTrade(A) never used env App ID', !credCalls.some((c) => c.appId === 'ENVLEAK-APP'));
  check('2. ManualTrade(A) diagnostics show TradingAccountId + App ID A', mA.logs.includes('TradingAccountId     : acct-A') && mA.logs.includes('App ID being used    : APPID-A'));

  credCalls.length = 0;
  const mB = await captureLogs(() => mts.placeOnMaster('acct-B', 'FYERS', dto));
  check('2. ManualTrade(B) called setCredentials with account B App ID', credCalls.some((c) => c.appId === 'APPID-B' && c.secretId === 'SECRET-B'), JSON.stringify(credCalls));
  check('2. ManualTrade(B) diagnostics show App ID B (independent of A)', mB.logs.includes('App ID being used    : APPID-B') && !mB.logs.includes('APPID-A'));

  // ======================================================================
  // PART 3 — OrderActionsService exit/cancel bind per-account credentials.
  // ======================================================================
  const oas = new OrderActionsService(makePrisma(), enc, null, null, null);
  const positionA = { broker: 'FYERS', masterAccountId: 'acct-A', brokerOrderId: 'OID-A', symbol: 'NSE:SBIN-EQ', side: 'BUY', productType: 'INTRADAY', exchange: 'NSE' };

  credCalls.length = 0;
  const exitA = await captureLogs(() => oas.callMasterExit(positionA, 1));
  check('3. OrderActions.exit(A) called setCredentials with account A App ID', credCalls.some((c) => c.appId === 'APPID-A'), JSON.stringify(credCalls));
  check('3. OrderActions.exit(A) diagnostics show App ID A (not none/env)', exitA.logs.includes('App ID being used    : APPID-A'));

  credCalls.length = 0;
  await captureLogs(() => oas.callMasterCancel(positionA));
  check('3. OrderActions.cancel(A) called setCredentials with account A App ID', credCalls.some((c) => c.appId === 'APPID-A'), JSON.stringify(credCalls));

  const positionB = { ...positionA, masterAccountId: 'acct-B', brokerOrderId: 'OID-B' };
  credCalls.length = 0;
  await captureLogs(() => oas.callMasterExit(positionB, 1));
  check('3. OrderActions.exit(B) called setCredentials with account B App ID (independent)', credCalls.some((c) => c.appId === 'APPID-B') && !credCalls.some((c) => c.appId === 'APPID-A'), JSON.stringify(credCalls));

  // ======================================================================
  // PART 4 — Structural guard: EVERY Fyers placement path in these services
  // binds per-account credentials (covers copy-trading + position-sync which
  // are driven by their large loops) and none reads the env App ID.
  // ======================================================================
  const SRC = '/app/apps/api/src';
  const files = [
    'manual-trading/manual-trade.service.ts',
    'order-actions/order-actions.service.ts',
    'position-lifecycle/position-synchronization.service.ts',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const lines = text.split('\n');
    let everyAdapterCredentialed = true;
    let count = 0;
    lines.forEach((line, i) => {
      if (line.includes('new FyersAdapter()')) {
        count += 1;
        const window = lines.slice(i, i + 20).join('\n');
        if (!/\.setCredentials\(/.test(window)) everyAdapterCredentialed = false;
      }
    });
    check(`4. ${rel}: every "new FyersAdapter()" (${count}) is followed by setCredentials()`, count > 0 && everyAdapterCredentialed);
    check(`4. ${rel}: does NOT read FYERS_APP_ID/SECRET from env`, !/process\.env\.FYERS_(APP_ID|SECRET_ID)/.test(text));
  }

  // CopyTradingService no longer constructs FyersAdapter inline: it delegates
  // EVERY follower placement to the Broker Factory
  // (BrokerService.getAdapterForAccount, via FollowerExecutionService), which
  // binds each account's OWN App ID + Secret centrally (account isolation is
  // proven by fyers_account_isolation_harness). The guard therefore verifies
  // the delegation + the absence of any inline adapter / env-App-ID leak.
  {
    const rel = 'copy-trading/copy-trading.service.ts';
    const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
    check(
      `4. ${rel}: does NOT construct FyersAdapter inline (delegates to Broker Factory)`,
      !/new FyersAdapter\(\)/.test(text),
    );
    check(
      `4. ${rel}: delegates follower placement to FollowerExecutionService (dynamic factory)`,
      /this\.followerExec\.place\(/.test(text),
    );
    check(
      `4. ${rel}: does NOT read FYERS_APP_ID/SECRET from env`,
      !/process\.env\.FYERS_(APP_ID|SECRET_ID)/.test(text),
    );
  }

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
