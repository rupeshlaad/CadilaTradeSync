/**
 * Regression harness — Zerodha (Kite Connect) order payload generation.
 *
 * Locks in the production fix for:
 *   "Market orders without market protection are not allowed via API.
 *    Please set market protection or use a Limit order."
 *
 * Root cause: the Zerodha MARKET payload omitted `market_protection`; the Kite
 * Connect API treats an omitted/0 value as an unprotected market order and
 * rejects it (Kite Web injects it automatically, the API does not). Fix lives
 * ONLY in ZerodhaAdapter.normalizeOrder: MARKET / SL-M get market_protection
 * = -1 (Kite "automatic") unless the caller supplied an explicit value.
 *
 * Runs the COMPILED dist. The real KiteConnect network call is replaced by a
 * spy on adapter.kite.placeOrder so we assert the EXACT (variety, params) that
 * would leave our system — no live broker, no Postgres/Redis.
 */
'use strict';
const path = require('path');
process.env.ZERODHA_API_KEY = process.env.ZERODHA_API_KEY || 'test-key';
const { ZerodhaAdapter } = require(path.resolve(__dirname, '../../apps/api/dist/brokers/zerodha/zerodha.adapter.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

// Build an adapter whose kite.placeOrder is a spy capturing (variety, params).
function spyAdapter(throwErr) {
  const a = new ZerodhaAdapter();
  const calls = [];
  a.kite = {
    placeOrder: async (variety, params) => {
      calls.push({ variety, params });
      if (throwErr) throw throwErr;
      return { order_id: '250813600000001' };
    },
  };
  return { a, calls };
}

// Payloads exactly as the follower translator / manual builder would emit.
const marketMis = (side) => ({ exchange: 'NSE', tradingsymbol: 'TATASTEEL', transaction_type: side, quantity: 5, product: 'MIS', order_type: 'MARKET', validity: 'DAY' });
const limit = (side) => ({ exchange: 'NSE', tradingsymbol: 'TATASTEEL', transaction_type: side, quantity: 5, product: 'MIS', order_type: 'LIMIT', price: 150.5, validity: 'DAY' });

(async () => {
  console.log('MARKET BUY — market_protection -1 injected, variety regular');
  { const { a, calls } = spyAdapter(); const r = await a.placeOrder(marketMis('BUY'));
    ok(calls.length === 1, 'placeOrder called once');
    ok(calls[0].variety === 'regular', 'variety=regular');
    ok(calls[0].params.market_protection === -1, 'market_protection=-1 injected');
    ok(calls[0].params.order_type === 'MARKET' && calls[0].params.product === 'MIS', 'MARKET/MIS preserved');
    ok(calls[0].params.transaction_type === 'BUY' && calls[0].params.quantity === 5, 'side/qty preserved');
    ok(!('variety' in calls[0].params), 'variety lifted out of params');
    ok(r.order_id === '250813600000001', 'order id returned'); }

  console.log('MARKET SELL — market_protection -1 injected');
  { const { a, calls } = spyAdapter(); await a.placeOrder(marketMis('SELL'));
    ok(calls[0].params.market_protection === -1, 'market_protection=-1'); ok(calls[0].params.transaction_type === 'SELL', 'SELL preserved'); }

  console.log('LIMIT BUY — NO market_protection, price preserved');
  { const { a, calls } = spyAdapter(); await a.placeOrder(limit('BUY'));
    ok(!('market_protection' in calls[0].params), 'no market_protection on LIMIT');
    ok(calls[0].params.price === 150.5 && calls[0].params.order_type === 'LIMIT', 'LIMIT/price preserved'); }

  console.log('LIMIT SELL — NO market_protection');
  { const { a, calls } = spyAdapter(); await a.placeOrder(limit('SELL'));
    ok(!('market_protection' in calls[0].params), 'no market_protection on LIMIT SELL'); }

  console.log('AMO MARKET — variety amo + market_protection -1');
  { const { a, calls } = spyAdapter(); await a.placeOrder({ ...marketMis('BUY'), variety: 'amo' });
    ok(calls[0].variety === 'amo', 'variety=amo'); ok(calls[0].params.market_protection === -1, 'market_protection=-1 on AMO MARKET'); ok(!('variety' in calls[0].params), 'variety not duplicated in params'); }

  console.log('AMO LIMIT — variety amo, NO market_protection');
  { const { a, calls } = spyAdapter(); await a.placeOrder({ ...limit('BUY'), variety: 'amo' });
    ok(calls[0].variety === 'amo', 'variety=amo'); ok(!('market_protection' in calls[0].params), 'no market_protection on AMO LIMIT'); }

  console.log('Intraday (MIS) product preserved');
  { const { a, calls } = spyAdapter(); await a.placeOrder(marketMis('BUY')); ok(calls[0].params.product === 'MIS', 'MIS preserved'); }

  console.log('CNC product preserved (delivery)');
  { const { a, calls } = spyAdapter(); await a.placeOrder({ ...marketMis('BUY'), product: 'CNC' }); ok(calls[0].params.product === 'CNC', 'CNC preserved'); ok(calls[0].params.market_protection === -1, 'CNC MARKET still protected'); }

  console.log('SL-M — market_protection -1 injected (market-on-trigger)');
  { const { a, calls } = spyAdapter(); await a.placeOrder({ exchange: 'NSE', tradingsymbol: 'TATASTEEL', transaction_type: 'SELL', quantity: 5, product: 'MIS', order_type: 'SL-M', trigger_price: 145, validity: 'DAY' });
    ok(calls[0].params.market_protection === -1, 'SL-M gets market_protection=-1'); ok(calls[0].params.trigger_price === 145, 'trigger_price preserved'); }

  console.log('SL (limit-on-trigger) — NO market_protection');
  { const { a, calls } = spyAdapter(); await a.placeOrder({ exchange: 'NSE', tradingsymbol: 'TATASTEEL', transaction_type: 'SELL', quantity: 5, product: 'MIS', order_type: 'SL', price: 146, trigger_price: 145, validity: 'DAY' });
    ok(!('market_protection' in calls[0].params), 'no market_protection on SL'); }

  console.log('Explicit market_protection respected (never overridden)');
  { const { a, calls } = spyAdapter(); await a.placeOrder({ ...marketMis('BUY'), market_protection: 5 }); ok(calls[0].params.market_protection === 5, 'P5=5 respected'); }
  { const { a, calls } = spyAdapter(); await a.placeOrder({ ...marketMis('BUY'), market_protection: 0 }); ok(calls[0].params.market_protection === 0, 'explicit NONE=0 respected (not overridden to -1)'); }

  console.log('Rejected / broker validation error — payload still correct, error propagates');
  { const err = Object.assign(new Error('Market orders without market protection are not allowed via API.'), { error_type: 'InputException' });
    const { a, calls } = spyAdapter(err); let threw = false;
    try { await a.placeOrder(marketMis('BUY')); } catch (e) { threw = true; ok(/market protection/i.test(e.message), 'broker error message propagated'); }
    ok(threw === true, 'adapter does not swallow broker rejection');
    ok(calls[0].params.market_protection === -1, 'payload was correctly built even when broker rejects'); }

  console.log('normalizeOrder is pure (input object not mutated)');
  { const { a } = spyAdapter(); const input = marketMis('BUY'); a.normalizeOrder(input); ok(!('market_protection' in input), 'caller input not mutated'); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
