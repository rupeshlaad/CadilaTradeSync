/**
 * InstrumentIntegrityService — Sprint 6.2.8 exchange-aware dedupe regression.
 *
 * The dedupe/count logic is raw SQL ($queryRawUnsafe / $executeRawUnsafe), so it
 * cannot execute without Postgres (forbidden in this pod). This harness therefore:
 *   (A) STATICALLY asserts the compiled service SQL keys on
 *       (broker, brokerSymbol, exchange) — guarding against a regression to the
 *       stale (broker, brokerSymbol) key; and
 *   (B) faithfully SIMULATES the exact SQL predicates in JS and proves the
 *       required behaviour for Case 1/2/3, plus that the OLD stale rule would
 *       have destroyed the NSE/BSE listings (demonstrating the fix).
 *
 * Run: node backend/tests/integrity_dedupe_exchange_harness.cjs   (from /app)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SVC_JS = path.join(
  __dirname, '..', '..', 'apps', 'api', 'dist', 'instruments',
  'instrument-integrity.service.js',
);
const sql = fs.readFileSync(SVC_JS, 'utf8');

const results = [];
const check = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} — ${e.message}`]); } };

// ---- (A) Static SQL guards ---------------------------------------------------
check('countDuplicateMappings GROUP BY includes exchange', () => {
  assert.ok(/GROUP BY broker,\s*"brokerSymbol",\s*exchange/.test(sql),
    'GROUP BY must key on (broker, brokerSymbol, exchange)');
});
check('countDuplicateMappings no longer groups on the stale 2-col key', () => {
  // The only GROUP BY in the file must be the 3-column one.
  const groupBys = sql.match(/GROUP BY[^\n]*/g) || [];
  assert.ok(groupBys.length >= 1, 'expected a GROUP BY');
  for (const g of groupBys) {
    assert.ok(/exchange/.test(g), `stale GROUP BY without exchange: ${g}`);
  }
});
check('removeDuplicateMappings DELETE join matches on exchange + tiebreaker', () => {
  assert.ok(/a\.exchange = b\.exchange/.test(sql), 'DELETE must require equal exchange');
  assert.ok(/a\."brokerSymbol" = b\."brokerSymbol"/.test(sql), 'DELETE must still match brokerSymbol');
  assert.ok(/a\.id > b\.id/.test(sql), 'DELETE needs a deterministic id tiebreaker for identical timestamps');
});

// ---- Faithful JS simulations of the SQL predicates ---------------------------
const key3 = (r) => `${r.broker}\u0000${r.brokerSymbol}\u0000${r.exchange}`;
const key2 = (r) => `${r.broker}\u0000${r.brokerSymbol}`; // OLD stale key

// "survivor per group" = row with min(createdAt, then id) — mirrors the DELETE:
// delete a if exists b in same group with (b.createdAt<a) OR (==, b.id<a.id).
function survivors(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push(g[0]); // exactly one survivor per group
  }
  return out;
}
// COUNT: sum(count-1) over groups with count>1.
function countDup(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) groups.set(keyFn(r), (groups.get(keyFn(r)) ?? 0) + 1);
  let extra = 0;
  for (const c of groups.values()) if (c > 1) extra += c - 1;
  return extra;
}
let _t = 0;
const row = (broker, brokerSymbol, exchange, id) => ({ broker, brokerSymbol, exchange, id: id ?? `id${++_t}`, createdAt: ++_t });

// ---- Case 1 — ZERODHA TCS NSE + BSE both survive -----------------------------
check('Case 1: ZERODHA/TCS NSE + BSE both survive (not duplicates)', () => {
  const rows = [row('ZERODHA', 'TCS', 'NSE'), row('ZERODHA', 'TCS', 'BSE')];
  assert.strictEqual(countDup(rows, key3), 0, 'must count 0 duplicates');
  const s = survivors(rows, key3);
  assert.strictEqual(s.length, 2, 'both rows must survive');
  assert.deepStrictEqual(s.map((r) => r.exchange).sort(), ['BSE', 'NSE']);
});

// ---- Case 2 — ICICI INFY NSE + BSE both survive ------------------------------
check('Case 2: ICICI_DIRECT/INFY NSE + BSE both survive', () => {
  const rows = [row('ICICI_DIRECT', 'INFY', 'NSE'), row('ICICI_DIRECT', 'INFY', 'BSE')];
  assert.strictEqual(countDup(rows, key3), 0);
  assert.strictEqual(survivors(rows, key3).length, 2);
});

// ---- Case 3 — true duplicates (identical triple) collapse to one -------------
check('Case 3a: identical (broker,brokerSymbol,exchange) collapse to one', () => {
  const rows = [row('ZERODHA', 'TCS', 'NSE'), row('ZERODHA', 'TCS', 'NSE'), row('ZERODHA', 'TCS', 'NSE')];
  assert.strictEqual(countDup(rows, key3), 2, 'two extras counted');
  const s = survivors(rows, key3);
  assert.strictEqual(s.length, 1, 'collapse to exactly one');
  assert.strictEqual(s[0].createdAt, Math.min(...rows.map((r) => r.createdAt)), 'earliest kept');
});
check('Case 3b: identical timestamps still collapse via id tiebreaker', () => {
  const a = { broker: 'ZERODHA', brokerSymbol: 'TCS', exchange: 'NSE', id: 'id-b', createdAt: 100 };
  const b = { broker: 'ZERODHA', brokerSymbol: 'TCS', exchange: 'NSE', id: 'id-a', createdAt: 100 };
  const s = survivors([a, b], key3);
  assert.strictEqual(s.length, 1, 'exactly one survivor even with equal createdAt');
  assert.strictEqual(s[0].id, 'id-a', 'min id kept deterministically');
});

// ---- Fix proof — OLD stale rule would have destroyed a listing ---------------
check('Fix proof: OLD (broker,brokerSymbol) rule WOULD delete a valid listing; new rule does not', () => {
  const rows = [row('ZERODHA', 'TCS', 'NSE'), row('ZERODHA', 'TCS', 'BSE')];
  assert.strictEqual(survivors(rows, key2).length, 1, 'stale rule collapses NSE+BSE → 1 (the bug)');
  assert.strictEqual(survivors(rows, key3).length, 2, 'fixed rule keeps both');
});

// ---- Mixed real-world set — only true dupes removed, listings preserved ------
check('Mixed: dual-listed preserved, true dupes removed', () => {
  const rows = [
    row('ZERODHA', 'TCS', 'NSE'), row('ZERODHA', 'TCS', 'BSE'),      // keep both
    row('ICICI_DIRECT', 'INFY', 'NSE'), row('ICICI_DIRECT', 'INFY', 'BSE'), // keep both
    row('FYERS', 'NSE:TCS-EQ', 'NSE'), row('FYERS', 'NSE:TCS-EQ', 'NSE'),   // true dup → 1
  ];
  assert.strictEqual(countDup(rows, key3), 1, 'exactly one true duplicate');
  const s = survivors(rows, key3);
  assert.strictEqual(s.length, 5, '6 rows → 5 after removing the single true dupe');
});

(() => {
  let pass = 0;
  for (const [ok, name] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`\nRESULT: ${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  process.exit(pass === results.length ? 0 : 1);
})();
