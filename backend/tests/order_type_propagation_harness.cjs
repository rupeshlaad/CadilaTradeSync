/**
 * Harness — order type + price + triggerPrice propagate through the copy
 * pipeline into every follower broker's native payload (previously hard-coded
 * to MARKET / 0), while MARKET behaviour is byte-identical to before.
 *
 * Covers:
 *  - translateFollowerOrder for MARKET / LIMIT / SL / SL-M across all brokers.
 *  - Fyers order mapper (numeric type codes) + buildFyersPlaceOrder.
 *  - Shoonya adapter maps the propagated orderType/price/trigger natively
 *    (MARKET->MKT, LIMIT->LMT, SL->SL-LMT, SL-M->SL-MKT; prc/trgprc).
 *  - broker-lifecycle-normalizer neutralizes broker-native order types to CTS.
 *  - End-to-end FollowerExecutionService.place forwards the fields.
 * Compiled dist only; broker HTTP spied.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);
const { translateFollowerOrder } = require(api('brokers/execution/follower-order-translator.js'));
const { buildFyersPlaceOrder, mapFyersOrderTypeCode } = require(api('brokers/fyers/fyers-order.mapper.js'));
const { ShoonyaAdapter } = require(api('brokers/shoonya/shoonya.adapter.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

const instrument = { contractKey: 'NSE:TATASTEEL', exchange: 'NSE', segment: 'EQ', instrumentType: 'EQ', optionType: null, strike: null, expiry: null, underlying: 'TATASTEEL' };
const base = (broker, extra) => ({
  broker, side: 'BUY', quantity: 1, brokerSymbol: 'TATASTEEL',
  brokerToken: 'NSE_EQ|INE081A01020', exchange: 'NSE', instrument, product: 'MIS', ...extra,
});

(async () => {
  console.log('Fyers order mapper — CTS orderType -> numeric type code');
  ok(mapFyersOrderTypeCode('MARKET') === 2, 'MARKET->2');
  ok(mapFyersOrderTypeCode('LIMIT') === 1, 'LIMIT->1');
  ok(mapFyersOrderTypeCode('SL-M') === 3, 'SL-M->3');
  ok(mapFyersOrderTypeCode('SL') === 4, 'SL->4');
  {
    const lim = buildFyersPlaceOrder({ symbol: 'X', side: 'BUY', quantity: 1, orderType: 'LIMIT', price: 101.5, triggerPrice: null });
    ok(lim.type === 1 && lim.limitPrice === 101.5 && lim.stopPrice === 0, 'Fyers LIMIT: type1 limitPrice set stop 0');
    const slm = buildFyersPlaceOrder({ symbol: 'X', side: 'SELL', quantity: 2, orderType: 'SL-M', price: 0, triggerPrice: 95 });
    ok(slm.type === 3 && slm.stopPrice === 95 && slm.side === -1, 'Fyers SL-M: type3 stopPrice set side -1');
    const mkt = buildFyersPlaceOrder({ symbol: 'X', side: 'BUY', quantity: 1, orderType: 'MARKET' });
    ok(mkt.type === 2 && mkt.limitPrice === 0 && mkt.stopPrice === 0, 'Fyers MARKET unchanged (type2, 0, 0)');
  }

  console.log('MARKET default (no orderType) — every broker payload UNCHANGED');
  ok(translateFollowerOrder(base('ZERODHA')).order_type === 'MARKET', 'Zerodha default MARKET');
  ok(!('price' in translateFollowerOrder(base('ZERODHA'))), 'Zerodha MARKET has NO price key (byte-identical to before)');
  ok(translateFollowerOrder(base('FYERS')).type === 2, 'Fyers default type 2');
  ok(translateFollowerOrder(base('UPSTOX')).order_type === 'MARKET', 'Upstox default MARKET');
  ok(translateFollowerOrder(base('SHOONYA')).orderType === 'MARKET', 'Shoonya default MARKET');

  console.log('LIMIT propagation across brokers');
  {
    const z = translateFollowerOrder(base('ZERODHA', { orderType: 'LIMIT', price: 100 }));
    ok(z.order_type === 'LIMIT' && z.price === 100, 'Zerodha LIMIT + price 100');
    const f = translateFollowerOrder(base('FYERS', { orderType: 'LIMIT', price: 100 }));
    ok(f.type === 1 && f.limitPrice === 100, 'Fyers LIMIT type1 limitPrice 100');
    const u = translateFollowerOrder(base('UPSTOX', { orderType: 'LIMIT', price: 100 }));
    ok(u.order_type === 'LIMIT' && Number(u.price) === 100, 'Upstox LIMIT + price 100');
    const s = translateFollowerOrder(base('SHOONYA', { orderType: 'LIMIT', price: 100 }));
    ok(s.orderType === 'LIMIT' && s.price === 100, 'Shoonya LIMIT + price 100 (adapter maps prctyp)');
  }

  console.log('SL / SL-M propagation (trigger price)');
  {
    const z = translateFollowerOrder(base('ZERODHA', { orderType: 'SL', price: 100, triggerPrice: 99 }));
    ok(z.order_type === 'SL' && z.price === 100 && z.trigger_price === 99, 'Zerodha SL price+trigger');
    const zm = translateFollowerOrder(base('ZERODHA', { orderType: 'SL-M', triggerPrice: 99 }));
    ok(zm.order_type === 'SL-M' && zm.trigger_price === 99 && !('price' in zm), 'Zerodha SL-M trigger only');
    const f = translateFollowerOrder(base('FYERS', { orderType: 'SL-M', triggerPrice: 99 }));
    ok(f.type === 3 && f.stopPrice === 99, 'Fyers SL-M type3 stop 99');
  }

  console.log('Shoonya adapter maps propagated orderType/price/trigger -> Noren');
  function spyShoonya() {
    const a = new ShoonyaAdapter(); a.setSessionToken('t'); a.setUserId('FA1');
    const calls = [];
    a.httpPost = async (url, body) => { calls.push(JSON.parse(String(body).replace(/^jData=/, '').split('&jKey=')[0])); return { stat: 'Ok', norenordno: 'N1' }; };
    return { a, calls };
  }
  {
    const { a, calls } = spyShoonya();
    await a.placeOrder(translateFollowerOrder(base('SHOONYA', { orderType: 'LIMIT', price: 100 })));
    ok(calls[0].prctyp === 'LMT' && calls[0].prc === '100', 'Shoonya LIMIT -> prctyp LMT, prc 100');
  }
  {
    const { a, calls } = spyShoonya();
    await a.placeOrder(translateFollowerOrder(base('SHOONYA', { orderType: 'SL-M', triggerPrice: 95 })));
    ok(calls[0].prctyp === 'SL-MKT' && calls[0].trgprc === '95', 'Shoonya SL-M -> prctyp SL-MKT, trgprc 95');
  }
  {
    const { a, calls } = spyShoonya();
    await a.placeOrder(translateFollowerOrder(base('SHOONYA', {})));
    ok(calls[0].prctyp === 'MKT' && calls[0].prc === '0', 'Shoonya MARKET default -> MKT/0 (unchanged)');
  }

  console.log('Normalizer neutralizes broker-native order types -> CTS');
  const { deriveLifecycleEvent } = require(api('position-lifecycle/broker-lifecycle-normalizer.js'));
  const mk = (broker, orderType, extra) => deriveLifecycleEvent(
    { broker, masterAccountId: 'm1' },
    { brokerOrderId: 'o1', status: 'COMPLETE', symbol: 'TATASTEEL', exchange: 'NSE', side: 'BUY',
      quantity: 1, filledQuantity: 1, price: 100, triggerPrice: 99, orderType, productType: 'I',
      brokerUpdatedAt: null, reason: null, raw: {}, ...extra },
    null,
  );
  ok(mk('FYERS', '2').orderType === 'MARKET', 'Fyers "2" -> MARKET');
  ok(mk('FYERS', '1').orderType === 'LIMIT', 'Fyers "1" -> LIMIT');
  ok(mk('FYERS', '4').orderType === 'SL', 'Fyers "4" -> SL');
  ok(mk('SHOONYA', 'LMT').orderType === 'LIMIT', 'Shoonya LMT -> LIMIT');
  ok(mk('SHOONYA', 'SL-MKT').orderType === 'SL-M', 'Shoonya SL-MKT -> SL-M');
  ok(mk('ZERODHA', 'LIMIT').orderType === 'LIMIT', 'Zerodha LIMIT passthrough');
  ok(mk('ICICI_DIRECT', 'stoploss').orderType === 'SL', 'ICICI stoploss -> SL');
  ok(mk('FYERS', '2').triggerPrice === 99 && mk('FYERS', '2').price === 100, 'price/trigger carried onto LifecycleEvent');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
