/**
 * Forensic capture (test-only, NO production code touched):
 * intercept the axios.post the compiled ShoonyaAdapter actually calls and
 * print the EXACT url, headers and raw form body CTS transmits for:
 *   BUY / NSE / TATASTEEL-EQ / MIS / MARKET / qty 1
 */
'use strict';
const path = require('path');
const APIDIR = '/app/apps/api';
const axios = require(path.join(APIDIR, 'node_modules/axios'));

let captured = null;
const spy = async (url, data, config) => {
  captured = { url, data, headers: (config && config.headers) || null };
  // Return a benign Noren-shaped OK so post()/placeOrder do not throw.
  return { status: 200, headers: { 'content-type': 'application/json' }, data: JSON.stringify({ stat: 'Ok', norenordno: 'FORENSIC' }) };
};
// axios v1 CJS: default export IS the instance; patch both faces.
if (axios.default) axios.default.post = spy;
axios.post = spy;

const { ShoonyaAdapter } = require(path.join(APIDIR, 'dist/brokers/shoonya/shoonya.adapter.js'));

(async () => {
  const a = new ShoonyaAdapter();
  a.setSessionToken('ACCESS_TOKEN_DEMO');
  a.setUserId('FA12345');
  await a.placeOrder({
    exchange: 'NSE', tradingSymbol: 'TATASTEEL-EQ', side: 'BUY',
    quantity: 1, product: 'MIS', orderType: 'MARKET', price: 0, validity: 'DAY',
  });

  console.log('================ CTS TRANSMITTED REQUEST ================');
  console.log('METHOD  : POST');
  console.log('URL     :', captured.url);
  console.log('HEADERS :', JSON.stringify(captured.headers, null, 2));
  console.log('BODY    :', captured.data);
  console.log('========================================================');
})().catch((e) => { console.error('CAPTURE ERROR', e); process.exit(1); });
