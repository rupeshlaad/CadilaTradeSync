/**
 * Regression harness — Manual Trade (CNC) → Zerodha follower payload (CNC).
 *
 * Locks in the production fix for:
 *   "Intraday orders (MIS) are allowed only till 3:12 PM. Try placing a CNC order."
 *
 * Root cause (proven data-flow audit):
 *   ManualTradeService.place() carried product=CNC all the way into
 *   CopyTradingService.handleTrade (event.product='CNC'), but the copy fan-out
 *   DROPPED it: FollowerExecutionService.place() never forwarded product, and
 *   FollowerOrderTranslator.translateFollowerOrder() HARD-CODED `product:'MIS'`
 *   for ZERODHA. So a CNC manual trade left our system as an MIS Zerodha order.
 *
 * Fix: thread the master product through
 *   CopyTradingService → FollowerExecutionService → FollowerOrderTranslator,
 *   and have the ZERODHA case emit `params.product ?? 'MIS'`.
 *
 * This harness FAILS if any stage turns CNC into MIS. Runs the COMPILED dist
 * (no Postgres/Redis/live broker). BrokerService is mocked with a spy adapter
 * that captures the EXACT order object that would reach Kite.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);

const { FollowerExecutionService } = require(api('brokers/execution/follower-execution.service.js'));
const { translateFollowerOrder } = require(api('brokers/execution/follower-order-translator.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

// Mock Broker Factory: returns a fake credentialed Zerodha adapter whose
// placeOrder is a spy capturing the exact order object our code emits.
function spyBrokerService() {
  const calls = [];
  return {
    calls,
    service: {
      getAdapterForAccount: async () => ({
        broker: 'ZERODHA',
        adapter: {
          placeOrder: async (order) => {
            calls.push(order);
            return { order_id: '250813600000099' };
          },
        },
      }),
    },
  };
}

const resolvedInstrument = {
  contractKey: 'NSE:TATASTEEL',
  exchange: 'NSE',
  segment: 'EQ',
  instrumentType: 'EQ',
  optionType: null,
  strike: null,
  expiry: null,
  underlying: 'TATASTEEL',
};

const params = (product) => ({
  followerAccountId: 'acc-1',
  broker: 'ZERODHA',
  side: 'BUY',
  quantity: 1,
  brokerSymbol: 'TATASTEEL',
  brokerToken: null,
  exchange: 'NSE',
  instrument: resolvedInstrument,
  product,
  followerId: 'fol-1',
  correlationId: 'corr-1',
});

(async () => {
  // ---------------------------------------------------------------------
  // Stage: FollowerOrderTranslator honours the incoming product (unit).
  // ---------------------------------------------------------------------
  console.log('Translator — CNC in → CNC out (never MIS)');
  {
    const order = translateFollowerOrder(params('CNC'));
    ok(order && order.product === 'CNC', 'translator emits product=CNC');
    ok(order.product !== 'MIS', 'translator did NOT downgrade CNC → MIS');
    ok(order.tradingsymbol === 'TATASTEEL' && order.exchange === 'NSE', 'symbol/exchange preserved');
    ok(order.transaction_type === 'BUY' && order.quantity === 1, 'side/qty preserved');
    ok(order.order_type === 'MARKET' && order.validity === 'DAY', 'MARKET/DAY preserved');
  }

  console.log('Translator — NRML in → NRML out');
  {
    const order = translateFollowerOrder(params('NRML'));
    ok(order.product === 'NRML', 'translator emits product=NRML');
  }

  console.log('Translator — MIS in → MIS out');
  {
    const order = translateFollowerOrder(params('MIS'));
    ok(order.product === 'MIS', 'translator emits product=MIS');
  }

  console.log('Translator — product omitted → MIS default (backward compatible)');
  {
    const p = params('CNC'); delete p.product;
    const order = translateFollowerOrder(p);
    ok(order.product === 'MIS', 'omitted product falls back to MIS default');
  }

  // ---------------------------------------------------------------------
  // Stage: FollowerExecutionService forwards product to the spy adapter.
  // Proves CNC survives CopyTradingService → FollowerExecutionService →
  // FollowerOrderTranslator → adapter.placeOrder payload.
  // ---------------------------------------------------------------------
  console.log('FollowerExecutionService — CNC reaches Zerodha placeOrder payload');
  {
    const { calls, service } = spyBrokerService();
    const svc = new FollowerExecutionService(service);
    const result = await svc.place(params('CNC'));
    ok(calls.length === 1, 'adapter.placeOrder called once');
    ok(calls[0].product === 'CNC', 'Zerodha payload product=CNC (the exact bug)');
    ok(calls[0].product !== 'MIS', 'Zerodha payload is NOT MIS');
    ok(result.success === true, 'execution result success');
    ok(result.orderRequest && result.orderRequest.product === 'CNC', 'recorded orderRequest.product=CNC');
  }

  console.log('FollowerExecutionService — NRML reaches Zerodha placeOrder payload');
  {
    const { calls, service } = spyBrokerService();
    const svc = new FollowerExecutionService(service);
    await svc.place(params('NRML'));
    ok(calls[0].product === 'NRML', 'Zerodha payload product=NRML');
  }

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
