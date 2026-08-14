/**
 * Regression harness — Zerodha (Kite Connect) product translation + validation.
 *
 * Locks in the production fix for:
 *   FYERS master (product 'INTRADAY') → Zerodha follower → Kite rejects
 *   "Invalid `product`" because Kite only accepts MIS / CNC / NRML.
 *
 * Root cause: a copy follower mirrors the MASTER's product verbatim. A FYERS
 * master places `productType='INTRADAY'`, which flowed unchanged into the
 * Zerodha payload. Kite does not understand CTS/cross-broker product enums.
 *
 * Fix (ZerodhaAdapter.normalizeOrder ONLY): translate the product via
 * PRODUCT_MAP (INTRADAY→MIS, DELIVERY→CNC, NORMAL/MARGIN→NRML), pass valid
 * Kite values through unchanged, and THROW before the API call on an
 * unsupported value.
 *
 * Runs the COMPILED dist. The real KiteConnect network call is spied; no live
 * broker / Postgres / Redis.
 */
'use strict';
const path = require('path');
process.env.ZERODHA_API_KEY = process.env.ZERODHA_API_KEY || 'test-key';
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);
const { ZerodhaAdapter } = require(api('brokers/zerodha/zerodha.adapter.js'));
const { FollowerExecutionService } = require(api('brokers/execution/follower-execution.service.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

function spyAdapter() {
  const a = new ZerodhaAdapter();
  const calls = [];
  a.kite = { placeOrder: async (variety, params) => { calls.push({ variety, params }); return { order_id: 'Z1' }; } };
  return { a, calls };
}

const base = (product) => ({ exchange: 'NSE', tradingsymbol: 'TATASTEEL', transaction_type: 'BUY', quantity: 1, product, order_type: 'MARKET', validity: 'DAY' });

(async () => {
  console.log('CTS/cross-broker product → Kite product mapping');
  for (const [input, expected] of [
    ['INTRADAY', 'MIS'],
    ['DELIVERY', 'CNC'],
    ['NORMAL', 'NRML'],
    ['MARGIN', 'NRML'],
    ['MIS', 'MIS'],
    ['CNC', 'CNC'],
    ['NRML', 'NRML'],
    ['intraday', 'MIS'],   // case-insensitive
    ['  CNC  ', 'CNC'],     // trimmed
  ]) {
    const { a, calls } = spyAdapter();
    await a.placeOrder(base(input));
    ok(calls[0].params.product === expected, `product "${input}" → "${expected}"`);
    ok(calls[0].params.market_protection === -1, `  market_protection still -1 for ${input} MARKET`);
  }

  console.log('The exact reported bug: FYERS master INTRADAY never reaches Kite as INTRADAY');
  {
    const { a, calls } = spyAdapter();
    await a.placeOrder(base('INTRADAY'));
    ok(calls[0].params.product === 'MIS', 'INTRADAY mapped to MIS');
    ok(calls[0].params.product !== 'INTRADAY', 'raw CTS enum did NOT reach Kite');
  }

  console.log('Unsupported product is REJECTED before the API call');
  {
    const { a, calls } = spyAdapter();
    let threw = false;
    try { await a.placeOrder(base('FOOBAR')); } catch (e) { threw = true; ok(/invalid product/i.test(e.message), 'clear invalid-product error'); }
    ok(threw, 'placeOrder throws on unsupported product');
    ok(calls.length === 0, 'kite.placeOrder was NEVER called for the invalid product');
  }

  console.log('normalizeOrder is pure (input not mutated)');
  {
    const { a } = spyAdapter();
    const input = base('INTRADAY');
    a.normalizeOrder(input);
    ok(input.product === 'INTRADAY', 'caller input product not mutated');
  }

  console.log('End-to-end FYERS→Zerodha (MIS/INTRADAY) via FollowerExecutionService');
  {
    const calls = [];
    const svc = new FollowerExecutionService({
      getAdapterForAccount: async () => {
        const { a } = spyAdapter();
        a.kite = { placeOrder: async (variety, params) => { calls.push({ variety, params }); return 'Z-MIS-1'; } };
        return { broker: 'ZERODHA', adapter: a };
      },
    });
    const result = await svc.place({
      followerAccountId: 'acc-z', broker: 'ZERODHA', side: 'BUY', quantity: 1,
      brokerSymbol: 'TATASTEEL', brokerToken: null, exchange: 'NSE', instrument: { exchange: 'NSE' },
      product: 'INTRADAY', masterSymbol: 'NSE:TATASTEEL-EQ', followerId: 'f1', correlationId: 'c1',
    });
    ok(calls.length === 1, 'Kite placeOrder called once');
    ok(calls[0].params.product === 'MIS', 'Kite payload product=MIS (translated from INTRADAY)');
    ok(result.success === true && result.brokerOrderId === 'Z-MIS-1', 'execution success with broker order id');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
