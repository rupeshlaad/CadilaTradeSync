/**
 * Regression harness — follower fan-out broker payloads + permanent observability.
 *
 * Proves, against the COMPILED dist (no Postgres/Redis/live broker):
 *   1. Zerodha copy payload mirrors the master product:
 *        CNC → CNC, MIS → MIS, NRML → NRML, missing → MIS (backward compat).
 *   2. NO OTHER BROKER PAYLOAD CHANGES: Fyers / Upstox / ICICI translations are
 *      unchanged regardless of the incoming product (they intentionally do NOT
 *      consume params.product), and SHOONYA still returns null (unsupported).
 *   3. The permanent observability logging (logFollowerPayload +
 *      logBrokerResponse, emitted for EVERY broker inside
 *      FollowerExecutionService.place) executes without throwing and does not
 *      alter the order object sent to the adapter or the returned result.
 *
 * The broker adapter placeOrder is a spy (no live broker). Fails if any stage
 * turns CNC into MIS, or if a non-Zerodha payload shape changes.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);

const { FollowerExecutionService } = require(api('brokers/execution/follower-execution.service.js'));
const { translateFollowerOrder } = require(api('brokers/execution/follower-order-translator.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

const instrument = {
  contractKey: 'NSE:TATASTEEL', exchange: 'NSE', segment: 'EQ',
  instrumentType: 'EQ', optionType: null, strike: null, expiry: null, underlying: 'TATASTEEL',
};

const base = (broker, product) => ({
  followerAccountId: 'acc-1', broker, side: 'BUY', quantity: 1,
  brokerSymbol: 'TATASTEEL', brokerToken: 'NSE_EQ|INE081A01020', exchange: 'NSE',
  instrument, product, masterSymbol: 'TATASTEEL', followerId: 'fol-1', correlationId: 'corr-xyz',
});

function spyBrokerService(broker) {
  const calls = [];
  return {
    calls,
    service: {
      getAdapterForAccount: async () => ({
        broker,
        adapter: { placeOrder: async (order) => { calls.push(order); return { order_id: 'OID1', status: 'COMPLETE' }; } },
      }),
    },
  };
}

(async () => {
  // ---- 1. Zerodha product mirroring (pure translator) ----
  console.log('Zerodha translator mirrors master product');
  ok(translateFollowerOrder(base('ZERODHA', 'CNC')).product === 'CNC', 'CNC → CNC');
  ok(translateFollowerOrder(base('ZERODHA', 'MIS')).product === 'MIS', 'MIS → MIS');
  ok(translateFollowerOrder(base('ZERODHA', 'NRML')).product === 'NRML', 'NRML → NRML');
  { const p = base('ZERODHA', 'CNC'); delete p.product;
    ok(translateFollowerOrder(p).product === 'MIS', 'missing → MIS (backward compat)'); }

  // ---- 2. No other broker payload changes (product must NOT leak in) ----
  console.log('Fyers payload unchanged regardless of product');
  {
    const withCnc = translateFollowerOrder(base('FYERS', 'CNC'));
    const withNone = translateFollowerOrder(base('FYERS', undefined));
    ok(withCnc.productType === 'INTRADAY', 'Fyers productType stays INTRADAY (not CNC)');
    ok(JSON.stringify(withCnc) === JSON.stringify(withNone), 'Fyers payload identical with/without product');
    ok(withCnc.symbol === 'TATASTEEL' && withCnc.type === 2 && withCnc.side === 1, 'Fyers core fields intact');
  }

  console.log('Upstox payload unchanged regardless of product');
  {
    const withCnc = translateFollowerOrder(base('UPSTOX', 'CNC'));
    const withNone = translateFollowerOrder(base('UPSTOX', undefined));
    ok(withCnc.product === 'I', 'Upstox product stays I (MIS default, not delivery)');
    ok(JSON.stringify(withCnc) === JSON.stringify(withNone), 'Upstox payload identical with/without product');
    ok(withCnc.order_type === 'MARKET' && withCnc.transaction_type === 'BUY', 'Upstox core fields intact');
  }

  console.log('ICICI payload unchanged regardless of product');
  {
    const withCnc = translateFollowerOrder(base('ICICI_DIRECT', 'CNC'));
    const withNone = translateFollowerOrder(base('ICICI_DIRECT', undefined));
    ok(withCnc.product === 'cash', 'ICICI product resolved from instrument (cash), not from product');
    ok(JSON.stringify(withCnc) === JSON.stringify(withNone), 'ICICI payload identical with/without product');
    ok(withCnc.stock_code === 'TATASTEEL' && withCnc.action === 'buy', 'ICICI core fields intact');
  }

  console.log('Shoonya now supported — translation returns a broker-neutral order');
  {
    const s = translateFollowerOrder(base('SHOONYA', 'CNC'));
    ok(s !== null, 'Shoonya translation returns a non-null order (copy execution implemented)');
    ok(s.tradingSymbol === 'TATASTEEL' && s.side === 'BUY', 'Shoonya order carries symbol/side (Noren encoding stays in the adapter)');
  }

  // ---- 3. Observability path runs for EVERY broker without throwing ----
  //     (logFollowerPayload is called BEFORE the try block; if it threw,
  //      place() would reject — so a resolved success proves it is safe.)
  console.log('Observability logging executes for all brokers (no throw, payload/result unchanged)');
  for (const broker of ['ZERODHA', 'FYERS', 'UPSTOX', 'ICICI_DIRECT']) {
    const { calls, service } = spyBrokerService(broker);
    const svc = new FollowerExecutionService(service);
    const result = await svc.place(base(broker, 'CNC'));
    ok(calls.length === 1, `${broker}: placeOrder called once (logging did not throw)`);
    ok(result && typeof result.success === 'boolean', `${broker}: returned normalized result (both observability blocks ran)`);
    ok(JSON.stringify(result.orderRequest) === JSON.stringify(calls[0]), `${broker}: logged/sent payload not mutated`);
  }
  // Zerodha specifically must carry CNC end-to-end into the sent payload.
  {
    const { calls, service } = spyBrokerService('ZERODHA');
    const svc = new FollowerExecutionService(service);
    await svc.place(base('ZERODHA', 'CNC'));
    ok(calls[0].product === 'CNC', 'ZERODHA sent payload product=CNC (the reported bug)');
  }

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
