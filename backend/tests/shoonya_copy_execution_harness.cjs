/**
 * Regression harness — Shoonya copy-execution translation + placement.
 *
 * Locks in the fix for:
 *   FYERS master → SHOONYA follower → "Broker SHOONYA has no copy-execution
 *   translation" (SKIPPED / BROKER_UNSUPPORTED). The execution never reached
 *   the Shoonya API because (a) the follower translator returned null for
 *   SHOONYA, (b) ShoonyaAdapter.placeOrder was a stub returning {}, and
 *   (c) the response normalizer had no SHOONYA branch.
 *
 * Fix:
 *   - follower-order-translator: SHOONYA case returns a broker-NEUTRAL order.
 *   - ShoonyaAdapter.placeOrder: maps that order into the Noren PlaceOrder
 *     field set (uid/actid/exch/tsym/qty/prc/prd/trantype/prctyp/ret) — ALL
 *     Shoonya-specific translation stays inside the adapter.
 *   - broker-response-normalizer: SHOONYA case reads { stat:'Ok', norenordno }.
 *
 * Runs the COMPILED dist. Noren HTTP is spied (adapter.post); no live broker.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);
const { ShoonyaAdapter } = require(api('brokers/shoonya/shoonya.adapter.js'));
const { translateFollowerOrder } = require(api('brokers/execution/follower-order-translator.js'));
const { normalizeExecutionResponse } = require(api('brokers/execution/broker-response-normalizer.js'));
const { FollowerExecutionService } = require(api('brokers/execution/follower-execution.service.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

// A real ShoonyaAdapter with its Noren POST spied so we capture the EXACT jData.
function spyShoonya() {
  const a = new ShoonyaAdapter();
  a.setSessionToken('tok-abc');
  a.setUserId('FA12345');
  const calls = [];
  a.post = async (pathName, jData) => { calls.push({ pathName, jData }); return { stat: 'Ok', norenordno: '25NOREN0001' }; };
  return { a, calls };
}

const params = (product) => ({
  broker: 'SHOONYA', side: 'BUY', quantity: 2, brokerSymbol: 'TATASTEEL-EQ',
  brokerToken: null, exchange: 'NSE', instrument: { exchange: 'NSE' }, product,
});

(async () => {
  console.log('Translator — SHOONYA now returns a non-null order (was BROKER_UNSUPPORTED)');
  {
    const order = translateFollowerOrder(params('MIS'));
    ok(order !== null, 'translator returns a Shoonya order (not null)');
    ok(order.tradingSymbol === 'TATASTEEL-EQ' && order.exchange === 'NSE', 'symbol/exchange carried');
    ok(order.side === 'BUY' && order.quantity === 2, 'side/qty carried');
    ok(order.orderType === 'MARKET', 'MARKET orderType');
  }

  console.log('Adapter mapProduct — CTS/cross-broker → Noren prd');
  for (const [inp, exp] of [['MIS','I'],['INTRADAY','I'],['CNC','C'],['DELIVERY','C'],['NRML','M'],['NORMAL','M'],['MARGIN','M']]) {
    ok(ShoonyaAdapter.mapProduct(inp) === exp, `product ${inp} → prd ${exp}`);
  }
  ok(ShoonyaAdapter.mapProduct('FOO') === null, 'unknown product → null (rejected)');

  console.log('placeOrder — MARKET BUY MIS builds correct Noren jData');
  {
    const { a, calls } = spyShoonya();
    const raw = await a.placeOrder(translateFollowerOrder(params('MIS')));
    ok(calls.length === 1 && calls[0].pathName === 'PlaceOrder', 'hits Noren PlaceOrder');
    const j = calls[0].jData;
    ok(j.uid === 'FA12345' && j.actid === 'FA12345', 'uid/actid set');
    ok(j.exch === 'NSE' && j.tsym === 'TATASTEEL-EQ', 'exch/tsym set');
    ok(j.qty === '2', 'qty string');
    ok(j.trantype === 'B', 'BUY → trantype B');
    ok(j.prctyp === 'MKT' && j.prc === '0', 'MARKET → prctyp MKT, prc 0');
    ok(j.prd === 'I', 'MIS → prd I');
    ok(j.ret === 'DAY', 'validity DAY');
    ok(raw.norenordno === '25NOREN0001', 'raw norenordno returned');
  }

  console.log('placeOrder — SELL CNC LIMIT builds correct Noren jData');
  {
    const { a, calls } = spyShoonya();
    await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'SELL', quantity: 5, product: 'CNC', orderType: 'LIMIT', price: 150.5, validity: 'DAY' });
    const j = calls[0].jData;
    ok(j.trantype === 'S', 'SELL → trantype S');
    ok(j.prctyp === 'LMT' && j.prc === '150.5', 'LIMIT → prctyp LMT, prc 150.5');
    ok(j.prd === 'C', 'CNC → prd C');
  }

  console.log('placeOrder — NRML → prd M');
  {
    const { a, calls } = spyShoonya();
    await a.placeOrder(translateFollowerOrder(params('NRML')));
    ok(calls[0].jData.prd === 'M', 'NRML → prd M');
  }

  console.log('placeOrder — invalid product REJECTED before the API call');
  {
    const { a, calls } = spyShoonya();
    let threw = false;
    try { await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'X-EQ', side: 'BUY', quantity: 1, product: 'FOO', orderType: 'MARKET' }); }
    catch (e) { threw = true; ok(/invalid product/i.test(e.message), 'clear invalid-product error'); }
    ok(threw, 'throws on invalid product');
    ok(calls.length === 0, 'Noren PlaceOrder was NEVER called');
  }

  console.log('placeOrder — missing session/uid guarded');
  {
    const a = new ShoonyaAdapter();
    let threw = false; try { await a.placeOrder(translateFollowerOrder(params('MIS'))); } catch (e) { threw = true; }
    ok(threw, 'no token → throws (no silent {} stub anymore)');
  }

  console.log('Response normalizer — SHOONYA success + failure');
  {
    const okRes = normalizeExecutionResponse('SHOONYA', { stat: 'Ok', norenordno: 'N123' });
    ok(okRes.success === true && okRes.brokerOrderId === 'N123', 'stat Ok + norenordno → SUCCESS');
    const failRes = normalizeExecutionResponse('SHOONYA', { stat: 'Not_ok', emsg: 'RMS: blocked' });
    ok(failRes.success === false, 'Not_ok → failure');
  }

  console.log('End-to-end FYERS→SHOONYA (CNC) via FollowerExecutionService');
  {
    const calls = [];
    const svc = new FollowerExecutionService({
      getAdapterForAccount: async () => {
        const a = new ShoonyaAdapter();
        a.setSessionToken('tok'); a.setUserId('FA999');
        a.post = async (pathName, jData) => { calls.push(jData); return { stat: 'Ok', norenordno: 'E2E-1' }; };
        return { broker: 'SHOONYA', adapter: a };
      },
    });
    const result = await svc.place({
      followerAccountId: 'acc-s', broker: 'SHOONYA', side: 'BUY', quantity: 1,
      brokerSymbol: 'TATASTEEL-EQ', brokerToken: null, exchange: 'NSE', instrument: { exchange: 'NSE' },
      product: 'CNC', masterSymbol: 'NSE:TATASTEEL-EQ', followerId: 'fs', correlationId: 'cs',
    });
    ok(calls.length === 1, 'Noren PlaceOrder called once (NOT skipped as unsupported)');
    ok(calls[0].prd === 'C' && calls[0].trantype === 'B', 'jData prd=C trantype=B');
    ok(result.success === true, 'result success (was BROKER_UNSUPPORTED skip before)');
    ok(result.category === 'SUCCESS' && result.brokerOrderId === 'E2E-1', 'SUCCESS + order id');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
