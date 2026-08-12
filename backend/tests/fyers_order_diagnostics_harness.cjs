/**
 * Static harness for the TEMPORARY Fyers order request/response diagnostics.
 *
 * PostgreSQL / a live Fyers session are not available in this pod, so the
 * compiled FyersAdapter is exercised with the underlying `fyers-api-v3` SDK
 * instance replaced by an in-memory double that records the payload it was
 * given and returns / throws a canned result.
 *
 * Proves the instrumentation is LOG-ONLY:
 *   - place_order() receives the EXACT payload passed to placeOrder() (byte
 *     identical — no field added/removed/mutated).
 *   - the resolved value of placeOrder() is the SDK response unchanged.
 *   - on an SDK rejection the SAME error is rethrown (not swallowed).
 *   - all three log blocks (REQUEST / RESPONSE / ERROR) are emitted with the
 *     documented fields, and secrets are masked (first 12 chars + ****).
 */
const assert = require('node:assert');

const DIST = '/app/apps/api/dist';
const { FyersAdapter } = require(`${DIST}/brokers/fyers/fyers.adapter.js`);

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra !== undefined ? ` :: ${extra}` : ''}`);
  }
}

// Capture stdout/stderr so we can inspect the emitted NestJS Logger output.
function captureLogs(fn) {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...a) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c, ...a) => { chunks.push(String(c)); return true; };
  return Promise.resolve()
    .then(fn)
    .then(
      (v) => { process.stdout.write = origOut; process.stderr.write = origErr; return { v, logs: chunks.join('') }; },
      (e) => { process.stdout.write = origOut; process.stderr.write = origErr; return { e, logs: chunks.join('') }; },
    );
}

function makeAdapter(sdkDouble) {
  const adapter = new FyersAdapter();
  // Replace the real SDK instance with the double (compiled JS: no real
  // private fields). setAppId / setRedirectUrl already ran in the ctor.
  adapter.fyers = sdkDouble;
  adapter.appId = 'GWNFK30KPO-200';
  adapter.setAccessToken('SECRET-ACCESS-TOKEN-0123456789ABCDEF');
  adapter.setOrderDiagnosticContext({
    tradingAccountId: 'acc-123',
    brokerUserId: 'BX4616',
    sourceModule: 'ManualTradeService.placeOnMaster (MANUAL)',
    environment: 'test',
    accessTokenExpiry: '2026-08-12T23:59:59.000Z',
  });
  return adapter;
}

const ORDER = {
  symbol: 'NSE:SBIN-EQ',
  qty: 1,
  type: 2,
  side: 1,
  productType: 'INTRADAY',
  limitPrice: 0,
  stopPrice: 0,
  disclosedQty: 0,
  validity: 'DAY',
  offlineOrder: false,
};

(async () => {
  // ---- Scenario A: success path -----------------------------------------
  let received;
  const okResponse = { s: 'ok', code: 1101, message: 'Order submitted', id: '25081100000123' };
  const adapterA = makeAdapter({
    place_order: async (o) => { received = o; return okResponse; },
    setAppId() {}, setRedirectUrl() {}, setAccessToken() {},
  });
  const beforeSnapshot = JSON.stringify(ORDER);
  const A = await captureLogs(() => adapterA.placeOrder(ORDER));

  check('A: no exception on success', A.e === undefined, A.e && A.e.message);
  check('A: placeOrder returns SDK response unchanged', A.v === okResponse);
  check('A: SDK place_order received the EXACT same object', received === ORDER);
  check('A: payload not mutated (deep-equal to snapshot)', JSON.stringify(ORDER) === beforeSnapshot);
  check('A: REQUEST block emitted', A.logs.includes('FYERS ORDER REQUEST'));
  check('A: RESPONSE block emitted', A.logs.includes('FYERS ORDER RESPONSE'));
  check('A: full endpoint URL logged', A.logs.includes('https://api-t1.fyers.in/api/v3/orders/sync'));
  check('A: HTTP method POST logged', A.logs.includes('HTTP Method          : POST'));
  check('A: order payload logged verbatim', A.logs.includes('"symbol":"NSE:SBIN-EQ"'));
  check('A: TradingAccountId logged', A.logs.includes('acc-123'));
  check('A: Broker User ID logged', A.logs.includes('BX4616'));
  check('A: App ID logged', A.logs.includes('GWNFK30KPO-200'));
  check('A: Source Module logged', A.logs.includes('ManualTradeService.placeOnMaster (MANUAL)'));
  check('A: response body logged', A.logs.includes('"id":"25081100000123"'));
  // Auth header masked: appId:token → first 12 chars then ****. Full token must NOT appear.
  check('A: auth header masked (first 12 + ****)', A.logs.includes('GWNFK30KPO-2****'));
  check('A: full access token NOT leaked', !A.logs.includes('SECRET-ACCESS-TOKEN-0123456789ABCDEF'));

  // ---- Scenario B: error path (must rethrow, not swallow) ---------------
  const boom = Object.assign(new Error('Order placement restricted. Algo orders are not allowed from this app.'), {
    code: -50,
    response: { status: 200, data: { s: 'error', code: -50, message: 'Algo orders are not allowed from this app.' } },
  });
  const adapterB = makeAdapter({
    place_order: async () => { throw boom; },
    setAppId() {}, setRedirectUrl() {}, setAccessToken() {},
  });
  const B = await captureLogs(() => adapterB.placeOrder(ORDER));

  check('B: SAME error rethrown (not swallowed)', B.e === boom, B.e && B.e.message);
  check('B: ERROR block emitted', B.logs.includes('FYERS ORDER ERROR'));
  check('B: error response body logged', B.logs.includes('Algo orders are not allowed from this app.'));
  check('B: axios-style flag logged true', B.logs.includes('Axios Error?         : true'));
  check('B: REQUEST block still emitted before error', B.logs.includes('FYERS ORDER REQUEST'));

  // ---- Scenario C: short/misconfigured App ID must NOT leak the token ----
  const adapterC = makeAdapter({
    place_order: async () => ({ s: 'ok', id: 'x' }),
    setAppId() {}, setRedirectUrl() {}, setAccessToken() {},
  });
  adapterC.appId = 'AB1'; // 3 chars — window capped at 'AB1:' boundary
  adapterC.setAccessToken('SUPERSECRETTOKENVALUE');
  const C = await captureLogs(() => adapterC.placeOrder(ORDER));
  check('C: short appId — token bytes NOT leaked', !C.logs.includes('SUPERSECRET'), 'token leaked for short appId');
  check('C: short appId — masked at boundary (AB1:****)', C.logs.includes('AB1:****'));

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
