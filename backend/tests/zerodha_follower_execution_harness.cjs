/**
 * Regression harness — Zerodha follower execution + dynamic broker execution.
 *
 * Permanently protects the fix that removed the hard-coded copy-trading broker
 * allow-list (FYERS + ICICI_DIRECT + UPSTOX) which skipped ZERODHA before an
 * adapter was ever instantiated (BROKER_UNSUPPORTED). Followers are now placed
 * through the existing Broker Factory (BrokerService.getAdapterForAccount)
 * wrapped by FollowerExecutionService, and every broker response is normalized
 * into a standardized result with a precise failure category.
 *
 * Runs the COMPILED dist (no Postgres/Redis/live broker). BrokerService is
 * mocked to return a fake adapter whose placeOrder returns/throws per scenario,
 * so real Kite/Fyers/Upstox/ICICI SDKs are never touched.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);

const { FollowerExecutionService } = require(api('brokers/execution/follower-execution.service.js'));
const { translateFollowerOrder } = require(api('brokers/execution/follower-order-translator.js'));
const { classifyBrokerMessage } = require(api('brokers/execution/broker-response-normalizer.js'));
const { ExecutionResultCategory, mapCategoryToStatus, isRetryable } = require(api('copy-trading/execution-result-category.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

// A mock Broker Factory: returns a fake credentialed adapter that resolves or
// throws exactly what the scenario dictates. `null` simulates "no session".
function mockBrokerService(broker, placeImpl) {
  return {
    getAdapterForAccount: async (_accountId) => {
      if (placeImpl === null) return null;
      return { broker, adapter: { placeOrder: async (order) => placeImpl(order) } };
    },
  };
}

const baseParams = (broker, overrides = {}) => ({
  followerAccountId: 'acc-1',
  broker,
  side: 'BUY',
  quantity: 1,
  brokerSymbol: 'TCS',
  brokerToken: 'NSE_EQ|INE467B01029',
  exchange: 'NSE',
  instrument: {
    contractKey: 'NSE:TCS',
    exchange: 'NSE',
    segment: 'EQ',
    instrumentType: 'EQ',
    optionType: null,
    strike: null,
    expiry: null,
    underlying: 'TCS',
  },
  followerId: 'f-1',
  correlationId: 'corr-123',
  ...overrides,
});

(async () => {
  console.log('Scenario 1 — Zerodha successful follower execution');
  {
    const svc = new FollowerExecutionService(
      mockBrokerService('ZERODHA', () => ({ order_id: '250811600123456' })),
    );
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.success === true, 'success=true');
    ok(r.category === ExecutionResultCategory.SUCCESS, 'category=SUCCESS');
    ok(r.brokerOrderId === '250811600123456', 'brokerOrderId captured');
    ok(mapCategoryToStatus(r.category) === 'SUCCESS', 'maps to SUCCESS status');
    ok(r.correlationId === 'corr-123', 'correlation id threaded');
    ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0, 'latency recorded');
    ok(!!r.orderRequest && r.orderRequest.order_type === 'MARKET', 'order request recorded (MARKET)');
    ok(r.retryable === false, 'success not retryable');
  }

  console.log('Scenario 2 — Zerodha broker rejection');
  {
    const svc = new FollowerExecutionService(
      mockBrokerService('ZERODHA', () => { throw { message: 'Order rejected: circuit limit' }; }),
    );
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.success === false, 'success=false');
    ok(r.category === ExecutionResultCategory.REJECTED_BY_BROKER, 'category=REJECTED_BY_BROKER');
    ok(mapCategoryToStatus(r.category) === 'FAILED', 'maps to FAILED status');
    ok(/circuit limit/.test(r.failureReason || ''), 'broker message preserved');
  }

  console.log('Scenario 3 — Zerodha token expired');
  {
    const svc = new FollowerExecutionService(
      mockBrokerService('ZERODHA', () => { throw { message: 'Invalid `access_token`.', error_type: 'TokenException' }; }),
    );
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.category === ExecutionResultCategory.TOKEN_EXPIRED, 'category=TOKEN_EXPIRED');
    ok(r.success === false, 'success=false');
  }

  console.log('Scenario 4 — Zerodha insufficient funds');
  {
    const svc = new FollowerExecutionService(
      mockBrokerService('ZERODHA', () => { throw { message: 'Insufficient funds for this order' }; }),
    );
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.category === ExecutionResultCategory.INSUFFICIENT_FUNDS, 'category=INSUFFICIENT_FUNDS');
  }

  console.log('Scenario 5 — Zerodha AMO rejection');
  {
    const svc = new FollowerExecutionService(
      mockBrokerService('ZERODHA', () => { throw { message: 'AMO orders are not allowed for this instrument' }; }),
    );
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.category === ExecutionResultCategory.AMO_NOT_SUPPORTED, 'category=AMO_NOT_SUPPORTED');
  }

  console.log('Scenario 6 — Mixed followers processed independently (Fyers OK, Zerodha reject, Upstox OK)');
  {
    const f = new FollowerExecutionService(mockBrokerService('FYERS', () => ({ s: 'ok', id: '11011', message: 'ok' })));
    const z = new FollowerExecutionService(mockBrokerService('ZERODHA', () => { throw { message: 'RMS rejection: blocked' }; }));
    const u = new FollowerExecutionService(mockBrokerService('UPSTOX', () => ({ data: { order_id: 'UP-1' } })));

    const rf = await f.place(baseParams('FYERS'));
    const rz = await z.place(baseParams('ZERODHA'));
    const ru = await u.place(baseParams('UPSTOX'));

    ok(rf.success === true && rf.category === ExecutionResultCategory.SUCCESS, 'Fyers follower success (preserved)');
    ok(rz.success === false && rz.category === ExecutionResultCategory.RMS_REJECTION, 'Zerodha follower RMS rejection');
    ok(ru.success === true && ru.brokerOrderId === 'UP-1', 'Upstox follower success (preserved)');
    ok(rf.success && !rz.success && ru.success, 'a failing follower did NOT affect the others');
  }

  console.log('Scenario 7 — Upstox / ICICI success detection preserved');
  {
    const icici = new FollowerExecutionService(
      mockBrokerService('ICICI_DIRECT', () => ({ Success: { order_id: 'IC-99' }, Status: 200, Error: null })),
    );
    const r = await icici.place(baseParams('ICICI_DIRECT'));
    ok(r.success === true && r.brokerOrderId === 'IC-99', 'ICICI order id captured from Success block');
    ok(r.httpStatus === 200, 'ICICI http status captured');
  }

  console.log('Scenario 8 — Zerodha order translation shape');
  {
    const order = translateFollowerOrder(baseParams('ZERODHA'));
    ok(order && order.tradingsymbol === 'TCS', 'tradingsymbol set');
    ok(order.exchange === 'NSE', 'exchange set');
    ok(order.transaction_type === 'BUY', 'transaction_type set');
    ok(order.order_type === 'MARKET', 'order_type MARKET');
    ok(order.product === 'MIS', 'product MIS');
  }

  console.log('Scenario 9 — Unsupported broker (SHOONYA) → BROKER_UNSUPPORTED, no adapter call');
  {
    let placed = false;
    const svc = new FollowerExecutionService(
      mockBrokerService('SHOONYA', () => { placed = true; return {}; }),
    );
    const r = await svc.place(baseParams('SHOONYA'));
    ok(r.category === ExecutionResultCategory.BROKER_UNSUPPORTED, 'category=BROKER_UNSUPPORTED');
    ok(mapCategoryToStatus(r.category) === 'SKIPPED', 'maps to SKIPPED status');
    ok(placed === false, 'adapter placeOrder never called for unsupported broker');
  }

  console.log('Scenario 10 — No broker session → NO_BROKER_SESSION skip');
  {
    const svc = new FollowerExecutionService(mockBrokerService('ZERODHA', null));
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.category === ExecutionResultCategory.NO_BROKER_SESSION, 'category=NO_BROKER_SESSION');
    ok(mapCategoryToStatus(r.category) === 'SKIPPED', 'maps to SKIPPED status');
  }

  console.log('Scenario 11 — Retryable transport categories');
  {
    const svc = new FollowerExecutionService(
      mockBrokerService('ZERODHA', () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }),
    );
    const r = await svc.place(baseParams('ZERODHA'));
    ok(r.category === ExecutionResultCategory.NETWORK_FAILURE, 'category=NETWORK_FAILURE');
    ok(r.retryable === true && isRetryable(r.category), 'network failure is retryable');
  }

  console.log('Scenario 12 — classifyBrokerMessage central mapping');
  {
    ok(classifyBrokerMessage('Insufficient margin') === ExecutionResultCategory.INSUFFICIENT_FUNDS, 'insufficient margin → INSUFFICIENT_FUNDS');
    ok(classifyBrokerMessage('Too many requests') === ExecutionResultCategory.BROKER_RATE_LIMIT, 'rate limit → BROKER_RATE_LIMIT');
    ok(classifyBrokerMessage('Trading in NSE is not allowed using NRML product type') === ExecutionResultCategory.PRODUCT_NOT_ALLOWED, 'product type → PRODUCT_NOT_ALLOWED');
    ok(classifyBrokerMessage('') === ExecutionResultCategory.UNKNOWN_BROKER_ERROR, 'empty → UNKNOWN_BROKER_ERROR');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
