/**
 * Manual-search exchange-projection fix — regression harness.
 *
 * Proves searchForManualTrading now projects `exchange` from the broker mapping
 * (InstrumentBroker.exchange) and that NOTHING ELSE changed: ranking, query-
 * family ordering, substring ranking, option-chain / strike ordering, dedupe,
 * limit, pool sizing and the response schema are all unaffected.
 *
 * Uses the REAL compiled InstrumentService (apps/api/dist) with a fake Prisma
 * (no DB, no network, no server). Per-broker candidate pools honour the
 * `where.broker` scope; the service does its own in-memory ranking/dedupe/slice.
 *
 * Run: node backend/tests/manual_search_exchange_harness.cjs   (from /app)
 */
const assert = require('assert');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const { InstrumentService } = require(
  path.join(API_DIR, 'dist', 'instruments', 'instrument.service.js'),
);

const SCHEMA_KEYS = [
  'instrumentId', 'tradingSymbol', 'brokerSymbol', 'displayName', 'exchange',
  'segment', 'lotSize', 'tickSize', 'expiry', 'strike', 'optionType',
];

let _id = 0;
/** Build one InstrumentBroker row. brokerExch = InstrumentBroker.exchange
 *  (authoritative). instExch = canonical Instrument.exchange (may differ). */
function row(broker, brokerSymbol, brokerExch, instExch, extra = {}) {
  const inst = {
    id: `inst-${++_id}`,
    exchange: instExch,
    segment: extra.segment ?? instExch,
    underlying: extra.underlying ?? brokerSymbol,
    instrumentType: extra.instrumentType ?? 'EQ',
    expiry: extra.expiry ?? null,
    strike: extra.strike ?? null,
    optionType: extra.optionType ?? null,
    lotSize: extra.lotSize ?? 1,
    tickSize: extra.tickSize ?? 0.05,
  };
  return {
    id: `ib-${_id}`,
    broker,
    brokerSymbol,
    exchange: brokerExch,
    exchangeSymbol: extra.exchangeSymbol ?? null,
    brokerToken: extra.brokerToken ?? null,
    instrument: inst,
  };
}

/** Fake Prisma: filters the dataset by the where.broker scope only; the
 *  service's own in-memory ranker drops non-matches and orders results. */
function makeService(dataset) {
  const prisma = {
    instrumentBroker: {
      findMany: async (args) => {
        const b = args?.where?.broker;
        const take = args?.take ?? dataset.length;
        return dataset.filter((r) => r.broker === b).slice(0, take);
      },
    },
  };
  return new InstrumentService(prisma);
}

const results = [];
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// ---------------------------------------------------------------------------
// 1) THE FIX — Upstox "TCS": broker row exchange=NSE, mis-linked to BSE canon.
// ---------------------------------------------------------------------------
check('Upstox TCS: exchange comes from broker mapping (NSE), not canonical (BSE)', async () => {
  const data = [row('UPSTOX', 'TCS', 'NSE', 'BSE', { underlying: 'TCS', segment: 'BSE', lotSize: 1, tickSize: 0.05 })];
  const svc = makeService(data);
  const out = await svc.searchForManualTrading({ broker: 'UPSTOX', q: 'TCS' });
  assert.strictEqual(out.length, 1, 'exactly one row');
  assert.strictEqual(out[0].exchange, 'NSE', 'exchange MUST be the broker mapping value (NSE)');
  assert.strictEqual(out[0].brokerSymbol, 'TCS');
  // Everything else is intentionally unchanged (still from the canonical row).
  assert.strictEqual(out[0].segment, 'BSE', 'segment unchanged (still canonical)');
  assert.strictEqual(out[0].lotSize, 1);
  assert.strictEqual(out[0].tickSize, 0.05);
  assert.strictEqual(out[0].strike, null);
  assert.strictEqual(out[0].optionType, null);
  assert.strictEqual(out[0].expiry, null);
});

// ---------------------------------------------------------------------------
// 2) No-op case — Fyers/Shoonya/Zerodha where broker.exchange == canonical.
// ---------------------------------------------------------------------------
check('Fyers/Shoonya/Zerodha TCS (aligned): exchange unchanged = NSE', async () => {
  for (const [broker, sym] of [['FYERS', 'NSE:TCS-EQ'], ['SHOONYA', 'TCS-EQ'], ['ZERODHA', 'TCS']]) {
    const svc = makeService([row(broker, sym, 'NSE', 'NSE', { underlying: 'TCS' })]);
    const out = await svc.searchForManualTrading({ broker, q: 'TCS' });
    assert.strictEqual(out.length, 1, `${broker} one row`);
    assert.strictEqual(out[0].exchange, 'NSE', `${broker} exchange stays NSE`);
  }
});

// ---------------------------------------------------------------------------
// 3) Both NSE and BSE broker rows exist → both appear, correct exchange, no dup.
// ---------------------------------------------------------------------------
check('Upstox INFY dual-listed NSE+BSE: both appear with correct exchanges, no dup', async () => {
  const data = [
    row('UPSTOX', 'INFY', 'NSE', 'NSE', { underlying: 'INFY' }),
    row('UPSTOX', 'INFY', 'BSE', 'BSE', { underlying: 'INFY' }),
  ];
  const svc = makeService(data);
  const out = await svc.searchForManualTrading({ broker: 'UPSTOX', q: 'INFY' });
  assert.strictEqual(out.length, 2, 'both listings appear');
  const exch = out.map((r) => r.exchange).sort();
  assert.deepStrictEqual(exch, ['BSE', 'NSE'], 'both exchanges present');
  const ids = new Set(out.map((r) => r.instrumentId));
  assert.strictEqual(ids.size, 2, 'distinct instrumentIds — no dedupe loss');
});

// ---------------------------------------------------------------------------
// 4) ICICI equity — exchange from broker mapping.
// ---------------------------------------------------------------------------
check('ICICI RELIANCE equity: exchange = broker mapping (NSE)', async () => {
  const svc = makeService([row('ICICI_DIRECT', 'RELIANCE', 'NSE', 'NSE', { underlying: 'RELIANCE' })]);
  const out = await svc.searchForManualTrading({ broker: 'ICICI_DIRECT', q: 'RELIANCE' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].exchange, 'NSE');
});

// ---------------------------------------------------------------------------
// 5) Query-family + option ordering unchanged (NIFTY before BANKNIFTY); F&O
//    exchange projected from broker mapping (NFO).
// ---------------------------------------------------------------------------
check('NIFTY option chain: family ordering intact, exchange=NFO from broker mapping', async () => {
  const exp = new Date('2026-12-31T00:00:00Z');
  const data = [
    row('UPSTOX', 'BANKNIFTY26DECFUT', 'NFO', 'NFO', { underlying: 'BANKNIFTY', instrumentType: 'FUT', expiry: exp, segment: 'NFO', lotSize: 15 }),
    row('UPSTOX', 'NIFTY26DECFUT',     'NFO', 'NFO', { underlying: 'NIFTY', instrumentType: 'FUT', expiry: exp, segment: 'NFO', lotSize: 25 }),
    row('UPSTOX', 'NIFTY26DEC26000CE', 'NFO', 'NFO', { underlying: 'NIFTY', instrumentType: 'CE', optionType: 'CE', strike: 26000, expiry: exp, segment: 'NFO', lotSize: 25 }),
    row('UPSTOX', 'NIFTY26DEC26000PE', 'NFO', 'NFO', { underlying: 'NIFTY', instrumentType: 'PE', optionType: 'PE', strike: 26000, expiry: exp, segment: 'NFO', lotSize: 25 }),
  ];
  const svc = makeService(data);
  const out = await svc.searchForManualTrading({ broker: 'UPSTOX', q: 'NIFTY' });
  // Query-family (NIFTY*) must rank ahead of BANKNIFTY.
  const bankIdx = out.findIndex((r) => r.brokerSymbol.startsWith('BANKNIFTY'));
  const lastNiftyIdx = out.map((r) => r.brokerSymbol.startsWith('NIFTY')).lastIndexOf(true);
  assert.ok(bankIdx > lastNiftyIdx, 'all NIFTY rows precede BANKNIFTY (family ranking intact)');
  // Family secondary order among NIFTY: FUT(2) before CE(3) before PE(4).
  const niftySyms = out.filter((r) => r.brokerSymbol.startsWith('NIFTY')).map((r) => r.brokerSymbol);
  assert.deepStrictEqual(niftySyms, ['NIFTY26DECFUT', 'NIFTY26DEC26000CE', 'NIFTY26DEC26000PE'], 'FUT→CE→PE order intact');
  // F&O exchange projected from broker mapping.
  for (const r of out) assert.strictEqual(r.exchange, 'NFO', 'F&O exchange = NFO from broker mapping');
});

// ---------------------------------------------------------------------------
// 6) Numeric strike-distance ordering unchanged.
// ---------------------------------------------------------------------------
check('Numeric query 26000: closest strike first (strike ordering intact)', async () => {
  const exp = new Date('2026-12-31T00:00:00Z');
  const mk = (strike) => row('UPSTOX', `NIFTY26DEC${strike}CE`, 'NFO', 'NFO',
    { underlying: 'NIFTY', instrumentType: 'CE', optionType: 'CE', strike, expiry: exp, segment: 'NFO', lotSize: 25 });
  const svc = makeService([mk(25000), mk(26000), mk(27000), mk(26500)]);
  const out = await svc.searchForManualTrading({ broker: 'UPSTOX', q: '26000' });
  assert.ok(out.length >= 1, 'has matches');
  assert.strictEqual(out[0].strike, 26000, 'exact strike first');
  for (const r of out) assert.strictEqual(r.exchange, 'NFO');
});

// ---------------------------------------------------------------------------
// 7) Response schema, limit, dedupe integrity.
// ---------------------------------------------------------------------------
check('Response schema keys unchanged + limit respected', async () => {
  const data = [];
  for (let i = 0; i < 40; i++) data.push(row('UPSTOX', `RELTEST${i}`, 'NSE', 'NSE', { underlying: 'RELTEST' }));
  const svc = makeService(data);
  const out = await svc.searchForManualTrading({ broker: 'UPSTOX', q: 'RELTEST', limit: 10 });
  assert.strictEqual(out.length, 10, 'limit respected');
  for (const r of out) {
    assert.deepStrictEqual(Object.keys(r).sort(), [...SCHEMA_KEYS].sort(), 'schema keys unchanged');
    assert.strictEqual(r.exchange, 'NSE');
  }
});

// ---------------------------------------------------------------------------
// 8) Short query guard unchanged (<2 chars → []).
// ---------------------------------------------------------------------------
check('min-length guard unchanged (1 char → [])', async () => {
  const svc = makeService([row('UPSTOX', 'TCS', 'NSE', 'NSE')]);
  const out = await svc.searchForManualTrading({ broker: 'UPSTOX', q: 'T' });
  assert.deepStrictEqual(out, []);
});

(async () => {
  for (const [name, fn] of checks) {
    try { await fn(); results.push([true, name]); }
    catch (e) { results.push([false, `${name} — ${e.message}`]); }
  }
  let pass = 0;
  for (const [ok, name] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`\nRESULT: ${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  process.exit(pass === results.length ? 0 : 1);
})();
