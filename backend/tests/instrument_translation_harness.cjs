/**
 * Regression harness — canonical InstrumentTranslationService.
 *
 * Locks in the FINAL instrument-resolution fix: ONE normalization +
 * deterministic-lookup path shared by the Translation UI and CopyTrading. The
 * production bug (CopyTrading failed INSTRUMENT_NOT_FOUND on
 * FYERS "NSE:TATASTEEL-EQ" while the UI resolved it) is covered directly by
 * scenario 1-4 (prefix/suffix normalization) and scenario 10 (exchange is a
 * preference, never a zeroing hard filter).
 *
 * Runs the COMPILED dist against an in-memory Prisma fake (no Postgres). The
 * service is never allowed to throw — unresolved lookups return structured
 * NOT_FOUND with every attempted key.
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);
const { InstrumentTranslationService } = require(api('instruments/instrument-translation.service.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

// ---- canonical instruments + broker mappings ----
const INSTRUMENTS = {
  tatasteel: { id: 'i-tatasteel', contractKey: 'NSE|TATASTEEL', exchange: 'NSE', segment: 'EQ', underlying: 'TATASTEEL', instrumentType: 'EQ', expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05 },
  tcsNse:    { id: 'i-tcs-nse', contractKey: 'NSE|TCS', exchange: 'NSE', segment: 'EQ', underlying: 'TCS', instrumentType: 'EQ', expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05 },
  tcsBse:    { id: 'i-tcs-bse', contractKey: 'BSE|TCS', exchange: 'BSE', segment: 'EQ', underlying: 'TCS', instrumentType: 'EQ', expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05 },
  bnfFut:    { id: 'i-bnf-fut', contractKey: 'NFO|BANKNIFTY|2026-01-29|FUT', exchange: 'NFO', segment: 'FUT', underlying: 'BANKNIFTY', instrumentType: 'FUT', expiry: new Date('2026-01-29'), strike: null, optionType: null, lotSize: 15, tickSize: 0.05 },
  niftyOpt:  { id: 'i-nifty-opt', contractKey: 'NFO|NIFTY|2026-01-08|26000|CE', exchange: 'NFO', segment: 'OPT', underlying: 'NIFTY', instrumentType: 'CE', expiry: new Date('2026-01-08'), strike: 26000, optionType: 'CE', lotSize: 75, tickSize: 0.05 },
};
const ib = (id, broker, brokerSymbol, exchange, brokerToken, exchangeSymbol, inst) =>
  ({ id, broker, brokerSymbol, exchange, brokerToken: brokerToken ?? null, exchangeSymbol: exchangeSymbol ?? null, exchangeToken: null, instrumentId: inst.id, instrument: inst });

const ROWS = [
  ib('m1', 'FYERS', 'NSE:TATASTEEL-EQ', 'NSE', '895745', 'TATASTEEL', INSTRUMENTS.tatasteel),
  ib('m2', 'ZERODHA', 'TATASTEEL', 'NSE', 'Z895745', 'TATASTEEL', INSTRUMENTS.tatasteel),
  ib('m3', 'UPSTOX', 'TATASTEEL', 'NSE', 'NSE_EQ|INE081A01020', 'TATASTEEL', INSTRUMENTS.tatasteel),
  ib('m4', 'ICICI_DIRECT', 'TATSTL', 'NSE', null, 'TATASTEEL', INSTRUMENTS.tatasteel),
  ib('m5', 'SHOONYA', 'TATASTEEL-EQ', 'NSE', '11536', 'TATASTEEL', INSTRUMENTS.tatasteel),
  ib('t1', 'FYERS', 'NSE:TCS-EQ', 'NSE', '11536', 'TCS', INSTRUMENTS.tcsNse),
  ib('t2', 'ZERODHA', 'TCS', 'NSE', 'Z11536', 'TCS', INSTRUMENTS.tcsNse),
  ib('t3', 'ZERODHA', 'TCS', 'BSE', 'Z500570', 'TCS', INSTRUMENTS.tcsBse),
  ib('b1', 'FYERS', 'NSE:BANKNIFTY26JANFUT', 'NFO', '55001', 'BANKNIFTY26JANFUT', INSTRUMENTS.bnfFut),
  ib('b2', 'ZERODHA', 'BANKNIFTY26JANFUT', 'NFO', 'Z55001', 'BANKNIFTY26JANFUT', INSTRUMENTS.bnfFut),
  ib('o1', 'FYERS', 'NSE:NIFTY26108C26000', 'NFO', '66001', 'NIFTY26108C26000', INSTRUMENTS.niftyOpt),
  ib('o2', 'ZERODHA', 'NIFTY2610826000CE', 'NFO', 'Z66001', 'NIFTY2610826000CE', INSTRUMENTS.niftyOpt),
];

const ci = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

const fakePrisma = {
  instrumentBroker: {
    findMany: async (args) => {
      const w = args.where || {};
      return ROWS.filter((r) => {
        if (w.broker && r.broker !== w.broker) return false;
        if (w.instrumentId && r.instrumentId !== w.instrumentId) return false;
        if (typeof w.brokerSymbol === 'string' && r.brokerSymbol !== w.brokerSymbol) return false;
        if (w.brokerSymbol && Array.isArray(w.brokerSymbol.in) && !w.brokerSymbol.in.includes(r.brokerSymbol)) return false;
        if (typeof w.brokerToken === 'string' && r.brokerToken !== w.brokerToken) return false;
        if (w.exchangeSymbol && Array.isArray(w.exchangeSymbol.in) && !w.exchangeSymbol.in.includes(r.exchangeSymbol)) return false;
        if (w.instrument && w.instrument.is && Array.isArray(w.instrument.is.OR)) {
          const anyMatch = w.instrument.is.OR.some((cond) => {
            if (cond.underlying && cond.underlying.equals !== undefined) return ci(r.instrument.underlying, cond.underlying.equals);
            if (cond.contractKey && cond.contractKey.equals !== undefined) return ci(r.instrument.contractKey, cond.contractKey.equals);
            return false;
          });
          if (!anyMatch) return false;
        }
        return true;
      });
    },
  },
  instrument: { findUnique: async () => null },
};

(async () => {
  const svc = new InstrumentTranslationService(fakePrisma);
  const T = (sourceBroker, sourceSymbol, targetBroker, exchange) =>
    svc.translate({ sourceBroker, sourceSymbol, targetBroker, exchange: exchange ?? null, correlationId: 'harness' });

  console.log('Scenario 1 — Fyers NSE:TATASTEEL-EQ -> Zerodha (exact)');
  { const r = await T('FYERS', 'NSE:TATASTEEL-EQ', 'ZERODHA', 'NSE');
    ok(r.found === true, 'found'); ok(r.targetSymbol === 'TATASTEEL', 'targetSymbol TATASTEEL');
    ok(r.token === 'Z895745', 'token'); ok(r.matchedStage === '1_EXACT_BROKER_SYMBOL', 'stage exact');
    ok(r.contractKey === 'NSE|TATASTEEL', 'canonical contractKey'); ok(r.lotSize === 1 && r.tickSize === 0.05, 'lot/tick'); }

  console.log('Scenario 2 — Fyers TATASTEEL-EQ (no prefix) -> Zerodha (normalized)');
  { const r = await T('FYERS', 'TATASTEEL-EQ', 'ZERODHA'); ok(r.found && r.targetSymbol === 'TATASTEEL', 'normalized prefix-strip resolves'); }

  console.log('Scenario 3 — Fyers NSE:TATASTEEL (no -EQ) -> Zerodha (canonical)');
  { const r = await T('FYERS', 'NSE:TATASTEEL', 'ZERODHA'); ok(r.found && r.targetSymbol === 'TATASTEEL', 'suffix-strip resolves'); }

  console.log('Scenario 4 — Fyers TATASTEEL (bare) -> Zerodha (canonical)');
  { const r = await T('FYERS', 'TATASTEEL', 'ZERODHA'); ok(r.found && r.targetSymbol === 'TATASTEEL', 'bare core resolves'); }

  console.log('Scenario 5 — Fyers -> Upstox (token carried)');
  { const r = await T('FYERS', 'NSE:TATASTEEL-EQ', 'UPSTOX'); ok(r.found && r.token === 'NSE_EQ|INE081A01020', 'upstox instrument token'); ok(r.instrumentToken === r.token, 'instrumentToken alias'); }

  console.log('Scenario 6 — Fyers -> ICICI');
  { const r = await T('FYERS', 'NSE:TATASTEEL-EQ', 'ICICI_DIRECT'); ok(r.found && r.targetSymbol === 'TATSTL', 'icici stock code'); ok(r.tradingSymbol === 'TATASTEEL', 'tradingSymbol from exchangeSymbol'); }

  console.log('Scenario 7 — Zerodha -> Fyers');
  { const r = await T('ZERODHA', 'TATASTEEL', 'FYERS'); ok(r.found && r.targetSymbol === 'NSE:TATASTEEL-EQ', 'fyers symbol'); }

  console.log('Scenario 8 — Upstox -> Zerodha');
  { const r = await T('UPSTOX', 'TATASTEEL', 'ZERODHA'); ok(r.found && r.targetSymbol === 'TATASTEEL', 'zerodha symbol'); }

  console.log('Scenario 9 — Shoonya TATASTEEL-EQ -> Zerodha');
  { const r = await T('SHOONYA', 'TATASTEEL-EQ', 'ZERODHA'); ok(r.found && r.targetSymbol === 'TATASTEEL', 'shoonya suffix normalized'); }

  console.log('Scenario 10 — TCS exchange preference (NSE pinned, BSE dup exists)');
  { const r = await T('FYERS', 'NSE:TCS-EQ', 'ZERODHA', 'NSE'); ok(r.found && r.exchange === 'NSE', 'target NSE listing'); ok(r.contractKey === 'NSE|TCS', 'NSE canonical, not BSE'); }

  console.log('Scenario 11 — BANKNIFTY future Fyers -> Zerodha');
  { const r = await T('FYERS', 'NSE:BANKNIFTY26JANFUT', 'ZERODHA'); ok(r.found && r.targetSymbol === 'BANKNIFTY26JANFUT', 'future symbol'); ok(r.instrumentType === 'FUT' && !!r.expiry, 'future facts (expiry/monthly)'); }

  console.log('Scenario 12 — NIFTY weekly option Fyers -> Zerodha');
  { const r = await T('FYERS', 'NSE:NIFTY26108C26000', 'ZERODHA'); ok(r.found && r.targetSymbol === 'NIFTY2610826000CE', 'option symbol'); ok(r.optionType === 'CE' && r.strike === 26000, 'option facts (strike/CE/weekly)'); }

  console.log('Scenario 13 — Missing instrument -> structured SOURCE_NOT_FOUND, never throws');
  { const r = await T('FYERS', 'NSE:DOESNOTEXIST-EQ', 'ZERODHA'); ok(r.found === false, 'not found'); ok(r.stage === 'SOURCE_NOT_FOUND', 'stage SOURCE_NOT_FOUND'); ok(Array.isArray(r.attempts) && r.attempts.length >= 5, 'all 5 attempts logged'); ok(r.attempts.every((a) => a.matched === false), 'every attempt failed'); }

  console.log('Scenario 14 — Target broker has no mapping -> TARGET_NOT_FOUND');
  { const r = await T('FYERS', 'NSE:BANKNIFTY26JANFUT', 'UPSTOX'); ok(r.found === false && r.stage === 'TARGET_NOT_FOUND', 'TARGET_NOT_FOUND'); }

  console.log('Scenario 15 — Normalization unit (all forms → same core)');
  { const n = svc.normalize('NSE:TATASTEEL-EQ'); ok(n.core === 'TATASTEEL', 'core=TATASTEEL');
    ok(svc.normalize('TATASTEEL-EQ').core === 'TATASTEEL' && svc.normalize('NSE:TATASTEEL').core === 'TATASTEEL' && svc.normalize('TATASTEEL').core === 'TATASTEEL', 'all variants share core'); }

  console.log('Scenario 16 — Same-broker translate returns same symbol');
  { const r = await T('FYERS', 'NSE:TATASTEEL-EQ', 'FYERS'); ok(r.found && r.targetSymbol === 'NSE:TATASTEEL-EQ', 'fyers->fyers identity'); }

  console.log('Scenario 17 — Instrument-token source lookup (stage 5)');
  { const r = await svc.translate({ sourceBroker: 'FYERS', sourceSymbol: '895745', targetBroker: 'ZERODHA', exchange: null }); ok(r.found && r.matchedStage === '5_INSTRUMENT_TOKEN', 'resolved via brokerToken'); ok(r.targetSymbol === 'TATASTEEL', 'token→canonical→target'); }

  console.log('Scenario 18 — Invalid / empty symbol never throws');
  { const r = await T('FYERS', '', 'ZERODHA'); ok(r.found === false, 'empty symbol → not found (no throw)'); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
