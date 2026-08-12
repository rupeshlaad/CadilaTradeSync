/**
 * Static logic harness — Manual Trade end-to-end pipeline trace.
 *
 * Runs the COMPILED trace module (apps/api/dist/observability/manual-trade-trace.js)
 * so it validates the exact code that ships. Proves:
 *   - Correlation ID format `CTS-MT-YYYYMMDD-000001`, zero-padded, monotonic.
 *   - AsyncLocalStorage scoping: a trace exists ONLY inside runWithManualTradeTrace
 *     and survives awaits; traceStage is a silent no-op outside a trace.
 *   - Stage / manual-stage tracking + the summary's "Missing Stage" and
 *     "Pipeline Completed" logic.
 *   - waitForPersistence: instant when no fan-out, resolves when history id lands.
 *
 * No Postgres / Redis / broker / network. Pure logic against the shipped dist.
 */
'use strict';

const path = require('path');
const MOD = path.resolve(
  __dirname,
  '../../apps/api/dist/observability/manual-trade-trace.js',
);

const trace = require(MOD);

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${label}`);
  } else {
    fail++;
    console.log(`  FAIL: ${label}`);
  }
}

// Capture stdout so we can assert on the emitted trace / summary lines.
function capture(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => {
    lines.push(chunk.toString());
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

(async () => {
  console.log('=== 1) Correlation ID format + sequence ===');
  const c1 = trace.nextCorrelationId();
  const c2 = trace.nextCorrelationId();
  const re = /^CTS-MT-\d{8}-\d{6}$/;
  ok(re.test(c1), `format matches CTS-MT-YYYYMMDD-000001 (${c1})`);
  ok(re.test(c2), `second id well-formed (${c2})`);
  const n1 = Number(c1.split('-')[3]);
  const n2 = Number(c2.split('-')[3]);
  ok(n2 === n1 + 1, `sequence increments (${n1} -> ${n2})`);
  ok(c1.split('-')[3].length === 6, 'sequence zero-padded to 6 digits');
  // fixed-date determinism
  const fixed = trace.nextCorrelationId(new Date('2026-08-12T00:00:00Z'));
  ok(fixed.startsWith('CTS-MT-20260812-'), `date component derived from arg (${fixed})`);

  console.log('=== 2) AsyncLocalStorage scoping ===');
  ok(trace.currentManualTradeTrace() === undefined, 'no trace outside run()');
  const ctx = trace.createManualTradeTraceContext();
  ok(re.test(ctx.correlationId), 'context carries a well-formed correlation id');

  const inside = await trace.runWithManualTradeTrace(ctx, async () => {
    const before = trace.currentManualTradeTrace();
    await new Promise((r) => setTimeout(r, 5)); // survive an await boundary
    const after = trace.currentManualTradeTrace();
    return { before, after };
  });
  ok(inside.before === ctx, 'store visible synchronously inside run()');
  ok(inside.after === ctx, 'store survives an await boundary (ALS propagation)');
  ok(trace.currentManualTradeTrace() === undefined, 'store cleared after run() resolves');

  console.log('=== 3) traceStage is a no-op outside a trace ===');
  let threw = false;
  try {
    trace.traceStage(1, { component: 'X', method: 'y', status: 'Z' }, true);
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'traceStage outside a trace does not throw');

  console.log('=== 4) Stage + manualStage tracking (unmatched vs matched) ===');
  const ctx4 = trace.createManualTradeTraceContext();
  trace.runWithManualTradeTrace(ctx4, () => {
    trace.traceStage(5, { component: 'PL', method: 'ingest', status: 'ACCEPTED' }, false); // e.g. NIFTY, not the manual order
    trace.traceStage(5, { component: 'PL', method: 'ingest', status: 'ACCEPTED' }, true); // the manual order
  });
  ok(ctx4.stagesSeen.has(5), 'stagesSeen records any stage-5 emission');
  ok(ctx4.manualStages.has(5), 'manualStages records only the matched (manual) stage 5');

  console.log('=== 5) Summary: Missing Stage + Pipeline Completed=NO (stuck) ===');
  const stuck = trace.createManualTradeTraceContext();
  stuck.ids.manualTradeId = 'mt-stuck';
  stuck.ids.brokerOrderId = 'FYERS-ORD-1';
  // reached 1..5 for the manual order but the fill never fanned out
  [1, 2, 3, 4, 5].forEach((s) => stuck.manualStages.add(s));
  stuck.manualStatus = 'EXECUTING_FOLLOWERS';
  const stuckOut = capture(() => trace.finalizeManualTradeTrace(stuck));
  ok(/CTS MANUAL TRADE SUMMARY/.test(stuckOut), 'summary block printed');
  ok(/Missing Stage\s*:\s*6\b/.test(stuckOut), 'first missing manual stage reported as 6');
  ok(/Pipeline Completed\s*:\s*NO/.test(stuckOut), 'pipeline reported NOT completed');
  ok(/Current Manual Status\s*:\s*EXECUTING_FOLLOWERS/.test(stuckOut), 'current manual status surfaced');
  ok(stuckOut.includes(stuck.correlationId), 'summary carries the correlation id');

  console.log('=== 6) Summary: full pipeline -> Completed=YES ===');
  const done = trace.createManualTradeTraceContext();
  done.ids.manualTradeId = 'mt-done';
  done.ids.brokerOrderId = 'FYERS-ORD-2';
  done.ids.executionEventId = 'xe_1';
  done.ids.executionHistoryId = 'eh_1';
  done.ids.masterPositionId = 'FYERS:acc:FYERS-ORD-2';
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach((s) => done.manualStages.add(s));
  done.manualStatus = 'COMPLETED';
  done.followerCount = 2;
  done.executed = 2;
  const doneOut = capture(() => trace.finalizeManualTradeTrace(done));
  ok(/Missing Stage\s*:\s*NONE/.test(doneOut), 'no missing stage when 1..10 reached');
  ok(/Pipeline Completed\s*:\s*YES/.test(doneOut), 'pipeline reported completed');
  ok(/Execution History ID\s*:\s*eh_1/.test(doneOut), 'execution history id in summary');
  ok(/Master Position ID\s*:\s*FYERS:acc:FYERS-ORD-2/.test(doneOut), 'master position id in summary');

  console.log('=== 7) waitForPersistence ===');
  const noFan = trace.createManualTradeTraceContext(); // no executionEventId
  const t0 = Date.now();
  await trace.waitForPersistence(noFan, 1000, 50);
  ok(Date.now() - t0 < 60, 'returns immediately when no fan-out occurred');

  const lagging = trace.createManualTradeTraceContext();
  lagging.ids.executionEventId = 'xe_lag';
  setTimeout(() => {
    lagging.ids.executionHistoryId = 'eh_lag';
  }, 120);
  const t1 = Date.now();
  await trace.waitForPersistence(lagging, 2000, 40);
  const waited = Date.now() - t1;
  ok(!!lagging.ids.executionHistoryId, 'history id eventually observed');
  ok(waited >= 100 && waited < 1500, `resolved shortly after id landed (${waited}ms)`);

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'RESULT: ALL PASS' : 'RESULT: FAILURES PRESENT');
  process.exit(fail === 0 ? 0 : 1);
})();
