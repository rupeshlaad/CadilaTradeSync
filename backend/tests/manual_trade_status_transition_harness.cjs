/**
 * Regression harness — Manual Trade status transition fix.
 *
 * Bug: ManualTradeService.handleExecutionCommit() exited early when
 * event.tradeSource !== 'MANUAL'. For Fyers manual orders the fill is
 * usually detected by the post-placement master-watcher reconciliation,
 * whose CopyTradingService fan-out commits the ExecutionEvent tagged
 * 'BROKER_POLL' — so the manual trade record never left
 * EXECUTING_FOLLOWERS even though ExecutionHistory reached a terminal
 * state.
 *
 * Fix: correlation is now purely by masterBrokerOrderId (the
 * byBrokerOrderId map only contains orders this service placed), with a
 * terminal-state guard so duplicate/late events are idempotent no-ops.
 *
 * Runs the COMPILED service (apps/api/dist) against the REAL compiled
 * ExecutionEventRecorderService — events are committed through the real
 * builder/commit/onCommit pipeline. No network, DB or broker calls.
 */
process.env.NODE_ENV = 'test';

const fs = require('node:fs');

const DIST = '/app/apps/api/dist';
const {
  ManualTradeService,
} = require(`${DIST}/manual-trading/manual-trade.service.js`);
const {
  ManualTradeStatus,
} = require(`${DIST}/manual-trading/manual-trade.types.js`);
const {
  ExecutionEventRecorderService,
} = require(`${DIST}/copy-trading/execution-event.recorder.js`);

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Wiring: real recorder + service with inert doubles for untouched deps.
// ---------------------------------------------------------------------------
const recorder = new ExecutionEventRecorderService();
const inert = {};
const svc = new ManualTradeService(inert, inert, inert, inert, inert, recorder);
svc.onModuleInit();

/** Seed a manual-trade record exactly as place() leaves it after broker
 *  acceptance: status EXECUTING_FOLLOWERS, correlated by broker order id. */
function seedRecord(id, broker, brokerOrderId, status) {
  const now = new Date().toISOString();
  const record = {
    id,
    masterAccountId: 'acc-master',
    masterAccountName: 'Master',
    strategyId: 'strat-1',
    strategyName: 'Strategy',
    broker,
    exchange: 'NSE',
    symbol: 'NSE:SBIN-EQ',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: 1,
    product: 'MIS',
    price: null,
    triggerPrice: null,
    validity: 'DAY',
    marketProtection: null,
    status,
    brokerOrderId,
    brokerResponse: { s: 'ok', code: 1101 },
    rejectionReason: null,
    failureType: null,
    failureStage: null,
    validation: { ok: true, checks: [], errors: [], validatedAt: now },
    executionEventId: null,
    followersFound: 1,
    followers: [],
    successfulFollowers: 0,
    failedFollowers: 0,
    skippedFollowers: 0,
    createdAt: now,
    updatedAt: now,
  };
  svc['records'].set(id, record);
  svc['byBrokerOrderId'].set(`${broker}:${brokerOrderId}`, id);
  return record;
}

/** Commit a real ExecutionEvent through the recorder pipeline. */
function commitEvent({ broker, orderId, tradeSource, followers = [], outcome }) {
  const builder = recorder.begin({
    masterAccountId: 'acc-master',
    masterAccountNickname: 'Master',
    broker,
    symbol: 'NSE:SBIN-EQ',
    side: 'BUY',
    quantity: 1,
    price: null,
    productType: 'MIS',
    tradeSource,
    orderId,
    timestamp: new Date(),
  });
  builder.setStrategy({ id: 'strat-1', name: 'Strategy' });
  builder.setFollowersFound(followers.length);
  for (const f of followers) {
    const h = builder.addFollower({
      followerId: f.id,
      followerName: f.name ?? f.id,
      followerEmail: f.email ?? `${f.id}@x.com`,
      followerAccountId: `${f.id}-acc`,
      broker: f.broker ?? 'ZERODHA',
    });
    if (f.result === 'SKIP') h.skip(f.failureType ?? 'BROKER_UNSUPPORTED', f.reason ?? 'skipped');
    else if (f.result === 'FAIL') h.fail(f.failureType ?? 'BROKER_ERROR', f.reason ?? 'failed');
    else h.succeed({ s: 'ok', id: `${f.id}-order` });
  }
  if (outcome === 'NO_ACTIVE_STRATEGY') builder.markNoActiveStrategy();
  if (outcome === 'NO_ENABLED_FOLLOWERS') builder.markNoEnabledFollowers();
  builder.commit();
  return recorder.getRecent(1)[0];
}

// ---------------------------------------------------------------------------
console.log('\nCase 1 — MANUAL-tagged event still finalises the record');
// ---------------------------------------------------------------------------
{
  const rec = seedRecord('mt-manual', 'FYERS', 'ORD-MANUAL-1', ManualTradeStatus.EXECUTING_FOLLOWERS);
  const ev = commitEvent({
    broker: 'FYERS',
    orderId: 'ORD-MANUAL-1',
    tradeSource: 'MANUAL',
    followers: [{ id: 'f1', broker: 'FYERS', result: 'SUCCESS' }],
  });
  check('status → COMPLETED', rec.status === ManualTradeStatus.COMPLETED, `got ${rec.status}`);
  check('executionEventId linked', rec.executionEventId === ev.id);
  check('successfulFollowers = 1', rec.successfulFollowers === 1);
}

// ---------------------------------------------------------------------------
console.log('\nCase 2 — BROKER_POLL event now finalises the record (the bug)');
// ---------------------------------------------------------------------------
let pollRec;
let pollEv;
{
  pollRec = seedRecord('mt-poll', 'FYERS', 'ORD-POLL-1', ManualTradeStatus.EXECUTING_FOLLOWERS);
  pollEv = commitEvent({
    broker: 'FYERS',
    orderId: 'ORD-POLL-1',
    tradeSource: 'BROKER_POLL',
    followers: [
      {
        id: 'zer-1',
        broker: 'ZERODHA',
        result: 'SKIP',
        failureType: 'BROKER_UNSUPPORTED',
        reason: 'Broker ZERODHA is not supported for copy execution',
      },
    ],
  });
  check(
    'status left EXECUTING_FOLLOWERS',
    pollRec.status !== ManualTradeStatus.EXECUTING_FOLLOWERS,
    `still ${pollRec.status}`,
  );
  check('status → FAILED (all followers skipped)', pollRec.status === ManualTradeStatus.FAILED, `got ${pollRec.status}`);
  check('skippedFollowers = 1', pollRec.skippedFollowers === 1);
  check('executionEventId linked', pollRec.executionEventId === pollEv.id);
  check('follower outcome carried onto record', pollRec.followers.length === 1 && pollRec.followers[0].status === 'SKIPPED');
}

// ---------------------------------------------------------------------------
console.log('\nCase 3 — duplicate BROKER_POLL event is idempotently ignored');
// ---------------------------------------------------------------------------
{
  const statusBefore = pollRec.status;
  const updatedBefore = pollRec.updatedAt;
  const eventIdBefore = pollRec.executionEventId;
  const dup = commitEvent({
    broker: 'FYERS',
    orderId: 'ORD-POLL-1',
    tradeSource: 'BROKER_POLL',
    followers: [{ id: 'zer-1', broker: 'ZERODHA', result: 'SKIP' }],
  });
  check('status unchanged', pollRec.status === statusBefore);
  check('updatedAt unchanged (no duplicate write)', pollRec.updatedAt === updatedBefore);
  check(
    'executionEventId still the FIRST event',
    pollRec.executionEventId === eventIdBefore && pollRec.executionEventId !== dup.id,
  );
}

// ---------------------------------------------------------------------------
console.log('\nCase 4 — unknown broker order id is safely ignored');
// ---------------------------------------------------------------------------
{
  const snapshot = JSON.stringify([...svc['records'].values()].map((r) => [r.id, r.status]));
  let threw = false;
  try {
    commitEvent({
      broker: 'FYERS',
      orderId: 'ORD-UNKNOWN-999',
      tradeSource: 'BROKER_POLL',
      followers: [{ id: 'fX', broker: 'FYERS', result: 'SUCCESS' }],
    });
  } catch {
    threw = true;
  }
  check('no exception thrown', !threw);
  check(
    'no record touched',
    JSON.stringify([...svc['records'].values()].map((r) => [r.id, r.status])) === snapshot,
  );
}

// ---------------------------------------------------------------------------
console.log('\nCase 5 — already-terminal record is never overwritten');
// ---------------------------------------------------------------------------
{
  for (const terminal of [
    ManualTradeStatus.COMPLETED,
    ManualTradeStatus.FAILED,
    ManualTradeStatus.PARTIAL,
    ManualTradeStatus.REJECTED,
  ]) {
    const rec = seedRecord(`mt-term-${terminal}`, 'FYERS', `ORD-TERM-${terminal}`, terminal);
    rec.successfulFollowers = 7; // sentinel — must survive untouched
    commitEvent({
      broker: 'FYERS',
      orderId: `ORD-TERM-${terminal}`,
      tradeSource: 'BROKER_POLL',
      followers: [{ id: 'fY', broker: 'FYERS', result: 'FAIL' }],
    });
    check(`terminal ${terminal} untouched`, rec.status === terminal && rec.successfulFollowers === 7);
  }
}

// ---------------------------------------------------------------------------
console.log('\nCase 6 — status mapping regression (MANUAL + BROKER_POLL parity)');
// ---------------------------------------------------------------------------
{
  const partial = seedRecord('mt-partial', 'FYERS', 'ORD-PARTIAL-1', ManualTradeStatus.EXECUTING_FOLLOWERS);
  commitEvent({
    broker: 'FYERS',
    orderId: 'ORD-PARTIAL-1',
    tradeSource: 'BROKER_POLL',
    followers: [
      { id: 'ok-1', broker: 'FYERS', result: 'SUCCESS' },
      { id: 'bad-1', broker: 'ICICI_DIRECT', result: 'FAIL' },
    ],
  });
  check('mixed outcome → PARTIAL', partial.status === ManualTradeStatus.PARTIAL, `got ${partial.status}`);

  const noFollowers = seedRecord('mt-nofoll', 'FYERS', 'ORD-NOFOLL-1', ManualTradeStatus.EXECUTING_FOLLOWERS);
  commitEvent({
    broker: 'FYERS',
    orderId: 'ORD-NOFOLL-1',
    tradeSource: 'BROKER_POLL',
    followers: [],
    outcome: 'NO_ENABLED_FOLLOWERS',
  });
  check('NO_ENABLED_FOLLOWERS → FAILED', noFollowers.status === ManualTradeStatus.FAILED, `got ${noFollowers.status}`);

  // Event with a null order id (recorder allows it) must never match.
  const idle = seedRecord('mt-idle', 'FYERS', 'ORD-IDLE-1', ManualTradeStatus.EXECUTING_FOLLOWERS);
  commitEvent({
    broker: 'FYERS',
    orderId: null,
    tradeSource: 'BROKER_POLL',
    followers: [{ id: 'fZ', broker: 'FYERS', result: 'SUCCESS' }],
  });
  check('null masterBrokerOrderId ignored', idle.status === ManualTradeStatus.EXECUTING_FOLLOWERS);
}

// ---------------------------------------------------------------------------
console.log('\nStructural guards — source of the fix');
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(
    '/app/apps/api/src/manual-trading/manual-trade.service.ts',
    'utf8',
  );
  check(
    'tradeSource early-return removed from handleExecutionCommit',
    !src.includes("if (event.tradeSource !== MANUAL_TRADE_SOURCE) return;"),
  );
  check('terminal-state guard present', src.includes('TERMINAL_STATUSES.has(record.status)'));
  check(
    'lifecycle ingest still tagged MANUAL (placement path unchanged)',
    src.includes('tradeSource: MANUAL_TRADE_SOURCE'),
  );
  check('match DEBUG log present', src.includes('matched ExecutionEvent'));
}

// ---------------------------------------------------------------------------
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
