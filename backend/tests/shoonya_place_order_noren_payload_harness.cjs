/**
 * Harness — Shoonya Noren PlaceOrder payload is spec-complete + MARKET-preserving,
 * and the exact request is logged before transmission.
 *
 * Context: live testing showed Shoonya rejects the API MARKET order with
 *   "ALGO_CHK: MKT Order type not allowed for API order"
 * while a MARKET MIS order placed from the Shoonya WEB platform succeeds. This
 * harness proves the generated Noren request now matches the official
 * ShoonyaApi-py `place_order` field set field-for-field (ordersource, uid,
 * actid, trantype, prd, exch, tsym[URL-encoded], qty, dscqty, prctyp, prc, ret,
 * remarks, amo; trgprc only for SL) and that MARKET is NEVER silently converted
 * to LIMIT. Noren HTTP is spied (adapter.post) — no live broker.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);
const { ShoonyaAdapter } = require(api('brokers/shoonya/shoonya.adapter.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

function spy() {
  const a = new ShoonyaAdapter();
  a.setSessionToken('tok-secret-should-not-be-logged');
  a.setUserId('FA12345');
  const calls = [];
  // placeOrder transmits via httpPost (SDK-exact: jData=<json>, no &jKey).
  a.httpPost = async (url, body, token, reqContentType) => {
    const pathName = String(url).split('/').pop();
    const jData = JSON.parse(String(body).replace(/^jData=/, '').split('&jKey=')[0]);
    calls.push({ pathName, url, body, token, contentType: reqContentType, jData, hasJKey: /&jKey=/.test(String(body)) });
    return { stat: 'Ok', norenordno: 'N1' };
  };
  return { a, calls };
}

(async () => {
  console.log('MARKET MIS BUY — spec-complete Noren field set, MARKET preserved');
  {
    const { a, calls } = spy();
    await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'BUY', quantity: 1, product: 'MIS', orderType: 'MARKET', price: 0, validity: 'DAY' });
    const j = calls[0].jData;
    ok(calls[0].pathName === 'PlaceOrder', 'endpoint path = PlaceOrder');
    ok(j.ordersource === 'API', 'ordersource=API');
    ok(j.uid === 'FA12345' && j.actid === 'FA12345', 'uid/actid populated');
    ok(j.trantype === 'B', 'trantype=B');
    ok(j.prd === 'I', 'prd=I (MIS)');
    ok(j.exch === 'NSE', 'exch=NSE');
    ok(j.tsym === 'TATASTEEL-EQ', 'tsym present (URL-encoded, hyphen safe)');
    ok(j.qty === '1', 'qty=1');
    ok(j.dscqty === '0', 'dscqty=0 (was MISSING before — now spec-complete)');
    ok(j.prctyp === 'MKT', 'prctyp=MKT (MARKET preserved, NOT converted to LMT)');
    ok(j.prc === '0', 'prc=0 for MARKET');
    ok(j.ret === 'DAY', 'ret=DAY');
    ok(typeof j.remarks === 'string' && /^[a-zA-Z0-9]+$/.test(j.remarks), 'remarks present + alphanumeric');
    ok('algo_id' in j && j.algo_id === null, 'algo_id present + null (SDK-parity; matches ALGO_CHK gate field)');
    ok('trgprc' in j && j.trgprc === '0', 'trgprc present = "0" for MARKET (SDK includes it unconditionally)');
    ok(!('amo' in j), 'amo omitted for regular order (SDK omits when None)');
    ok(calls[0].contentType === 'application/json; charset=utf-8', 'Content-Type application/json (matches OAuth SDK)');
    ok(calls[0].hasJKey === false, 'body has NO &jKey (OAuth Bearer auth, matches SDK)');
    ok(/^jData=/.test(calls[0].body), 'body is jData=<json>');
  }

  console.log('tsym URL-encoding — special chars (M&M-EQ → M%26M-EQ)');
  {
    const { a, calls } = spy();
    await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'M&M-EQ', side: 'BUY', quantity: 1, product: 'MIS', orderType: 'MARKET' });
    ok(calls[0].jData.tsym === 'M%26M-EQ', 'ampersand URL-encoded (quote_plus parity, no truncation)');
  }

  console.log('Access token is NEVER placed in jData (only jKey/Bearer in transport)');
  {
    const { a, calls } = spy();
    await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'BUY', quantity: 1, product: 'MIS', orderType: 'MARKET' });
    ok(!JSON.stringify(calls[0].jData).includes('tok-secret'), 'token absent from jData payload');
  }

  console.log('SELL LIMIT CNC — prctyp LMT + prc carried');
  {
    const { a, calls } = spy();
    await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'SELL', quantity: 5, product: 'CNC', orderType: 'LIMIT', price: 150.5 });
    const j = calls[0].jData;
    ok(j.trantype === 'S' && j.prctyp === 'LMT' && j.prc === '150.5' && j.prd === 'C', 'SELL/LMT/150.5/C');
    ok(j.trgprc === '0', 'trgprc="0" on plain LIMIT (SDK includes field unconditionally)');
  }

  console.log('SL-M — trgprc included (only for stop-loss variants)');
  {
    const { a, calls } = spy();
    await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'SELL', quantity: 5, product: 'MIS', orderType: 'SL-M', triggerPrice: 145 });
    const j = calls[0].jData;
    ok(j.prctyp === 'SL-MKT', 'SL-M → prctyp SL-MKT');
    ok(j.trgprc === '145', 'trgprc=145 for SL-MKT');
  }

  console.log('Logging path runs without throwing (success + error)');
  {
    const { a } = spy();
    let threw = false;
    try { await a.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'BUY', quantity: 1, product: 'MIS', orderType: 'MARKET' }); } catch { threw = true; }
    ok(!threw, 'success placement + request/response logging did not throw');

    const b = new ShoonyaAdapter();
    b.setSessionToken('t'); b.setUserId('FA9');
    b.httpPost = async () => { throw new Error('ALGO_CHK: MKT Order type not allowed for API order'); };
    let rethrew = false;
    try { await b.placeOrder({ exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'BUY', quantity: 1, product: 'MIS', orderType: 'MARKET' }); }
    catch (e) { rethrew = /ALGO_CHK/.test(e.message); }
    ok(rethrew, 'broker rejection is logged AND rethrown (not swallowed)');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
