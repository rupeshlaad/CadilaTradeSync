/**
 * End-to-end regression harness — Manual MARKET order must reach COMPLETE_FILL.
 *
 * Permanently protects against the production bug where a manual Fyers MARKET
 * order stalled at EXECUTING_FOLLOWERS because the immediate read-back was
 * still Pending (Fyers status 6) → classified NEW → dispatchFollowers returned
 * [] → no fan-out.
 *
 * Runs the COMPILED dist services (no Postgres/Redis/broker):
 *   A) ManualTradeService.pollUntilTerminal — read-back 6 then 2 → returns the
 *      Filled (status 2) order.
 *   B) REAL PositionLifecycleService — ingest(6)=NEW (no handleTrade) then
 *      ingest(2)=COMPLETE_FILL → CopyTradingService.handleTrade IS called.
 *   C) REAL ExecutionEventRecorder + REAL ManualTradeService.handleExecutionCommit
 *      — a committed fan-out event leaves EXECUTING_FOLLOWERS → COMPLETED and
 *      the event is retrievable from the Trade Monitor source (recorder buffer).
 */
'use strict';
const path = require('path');
const api = (p) => path.resolve(__dirname, '../../apps/api/dist', p);

const { ManualTradeService } = require(api('manual-trading/manual-trade.service.js'));
const { PositionLifecycleService } = require(api('position-lifecycle/position-lifecycle.service.js'));
const { ExecutionEventRecorderService } = require(api('copy-trading/execution-event.recorder.js'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS: ${l}`); } else { fail++; console.log(`  FAIL: ${l}`); } };

const fyersOrder = (status) => ({
  id: '26081200319994',
  status,
  symbol: 'NSE:TCS-EQ',
  side: 1,
  qty: 1,
  filledQty: status === 2 ? 1 : 0,
  tradedPrice: status === 2 ? 3820 : 0,
  limitPrice: 0,
  stopPrice: 0,
  type: 2,
  productType: 'INTRADAY',
  orderDateTime: new Date().toISOString(),
});

(async () => {
  // ---- Scenario A: bounded re-poll resolves Pending -> Filled ----
  console.log('=== A) pollUntilTerminal: read-back 6 then 2 ===');
  {
    const svc = new ManualTradeService({}, {}, {}, {}, {}, new ExecutionEventRecorderService());
    let fetchCalls = 0;
    svc.fetchPlacedOrder = async () => { fetchCalls++; return fyersOrder(2); }; // subsequent reads = Filled
    const resolved = await svc.pollUntilTerminal('acc1', 'FYERS', '26081200319994', fyersOrder(6), 5, 20, 1500);
    ok(resolved && resolved.status === 2, `resolves to Filled order (status=${resolved && resolved.status})`);
    ok(fetchCalls >= 1, `re-polled the broker at least once (calls=${fetchCalls})`);
  }

  // ---- Scenario B: real lifecycle classifies 6->NEW then 2->COMPLETE_FILL ----
  console.log('=== B) PositionLifecycleService: 6=NEW (no fan-out) -> 2=COMPLETE_FILL (fan-out) ===');
  {
    const handleTradeCalls = [];
    const copyTradingSpy = { handleTrade: async (evt) => { handleTradeCalls.push(evt); } };
    const store = new Map();
    const keyOf = (b, a, o) => `${b}:${a}:${o}`;
    const registry = {
      buildKey: keyOf,
      get: (k) => store.get(k),
      hasSignatureChanged: (k, sig) =>
        JSON.stringify(store.get(k)?.lastSignature) !== JSON.stringify(sig),
      rememberSignature: (k, sig) =>
        store.set(k, { ...(store.get(k) || { state: null }), lastSignature: sig }),
      appendTimeline: () => {},
      applyEvent: (event, nextState, _t, signature) => {
        const k = keyOf(event.broker, event.masterAccountId, event.brokerOrderId);
        const rec = { state: nextState, lastSignature: signature, event };
        store.set(k, rec);
        return rec;
      },
    };
    const prismaFake = { strategy: { findFirst: async () => ({ id: 's1' }) } };
    const lifecycle = new PositionLifecycleService(prismaFake, registry, {}, copyTradingSpy);

    const ctx = { broker: 'FYERS', tradingAccountId: 'acc1', tradeSource: 'MANUAL' };
    const o1 = await lifecycle.ingest(ctx, fyersOrder(6));
    ok(o1.accepted && o1.event && o1.event.type === 'NEW', `first ingest (status 6) classified NEW (${o1.event && o1.event.type})`);
    ok(handleTradeCalls.length === 0, 'handleTrade NOT called on NEW (matches the old dead-end — before the fix this is where it stopped)');

    const o2 = await lifecycle.ingest(ctx, fyersOrder(2));
    ok(o2.accepted && o2.event && o2.event.type === 'COMPLETE_FILL', `second ingest (status 2) classified COMPLETE_FILL (${o2.event && o2.event.type})`);
    ok(handleTradeCalls.length === 1, 'dispatchFollowers invoked CopyTradingService.handleTrade exactly once');
    ok(handleTradeCalls[0] && handleTradeCalls[0].symbol === 'NSE:TCS-EQ' && handleTradeCalls[0].side === 'BUY', 'handleTrade received the correct master trade (TCS BUY)');
  }

  // ---- Scenario C: committed fan-out event -> manual leaves EXECUTING_FOLLOWERS + Trade Monitor has it ----
  console.log('=== C) recorder.commit -> handleExecutionCommit -> COMPLETED + Trade Monitor record ===');
  {
    const recorder = new ExecutionEventRecorderService();
    const svc = new ManualTradeService({}, {}, {}, {}, {}, recorder);
    svc.onModuleInit(); // registers handleExecutionCommit as an onCommit subscriber

    const record = {
      id: 'mt1', broker: 'FYERS', brokerOrderId: '26081200319994',
      status: 'EXECUTING_FOLLOWERS', followers: [], followersFound: 0,
      successfulFollowers: 0, failedFollowers: 0, skippedFollowers: 0,
      executionEventId: null, rejectionReason: null, updatedAt: '',
    };
    svc.records.set('mt1', record);
    svc.byBrokerOrderId.set('FYERS:26081200319994', 'mt1');

    const b = recorder.begin({
      masterAccountId: 'acc1', masterAccountNickname: null, broker: 'FYERS',
      symbol: 'NSE:TCS-EQ', side: 'BUY', quantity: 1, productType: 'INTRADAY',
      orderId: '26081200319994', timestamp: new Date(),
    });
    b.setFollowersFound(1);
    b.addFollower({ followerId: 'f1', followerName: 'F', followerEmail: 'f@x.io', followerAccountId: 'fa1', broker: 'FYERS' }).succeed({ s: 'ok', id: 'FLW-ORD-1' });
    b.commit(); // fires handleExecutionCommit synchronously

    ok(record.status === 'COMPLETED', `manual record left EXECUTING_FOLLOWERS -> ${record.status}`);
    ok(record.status !== 'EXECUTING_FOLLOWERS', 'manual record is NOT stuck');
    ok(!!record.executionEventId, `manual record linked to execution event (${record.executionEventId})`);
    ok(record.successfulFollowers === 1, 'follower success tallied onto the manual record');
    const inMonitor = recorder.getById(record.executionEventId);
    ok(!!inMonitor, 'execution event retrievable from Trade Monitor source (recorder buffer)');
    ok(recorder.getRecent(10).some((e) => e.masterBrokerOrderId === '26081200319994'), 'Trade Monitor recent list contains the manual order');
  }

  console.log('');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'RESULT: ALL PASS' : 'RESULT: FAILURES PRESENT');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
