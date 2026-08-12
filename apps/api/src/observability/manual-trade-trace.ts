import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';

/**
 * Manual Trade end-to-end execution trace.
 *
 * A single, cross-cutting correlation trace for one admin-initiated
 * manual trade as it travels the EXISTING execution pipeline:
 *
 *   ManualTradeService.place
 *     → ManualTradeValidatorService.validate            (Stage 2)
 *     → ManualTradeService.placeOnMaster (broker adapter) (Stage 3)
 *     → ManualTradeService.fetchPlacedOrder               (Stage 4)
 *     → PositionLifecycleService.ingest                   (Stage 5)
 *     → ExecutionEventRecorderService.begin/commit        (Stage 6)
 *     → CopyTradingService.handleTrade (via committed evt) (Stage 7)
 *     → ExecutionHistoryService.persist                   (Stage 8)
 *     → ManualTradeService.handleExecutionCommit          (Stage 9)
 *     → Trade Monitor query (recorder buffer)             (Stage 10)
 *
 * The trace is purely observability. It NEVER influences control flow,
 * order placement, copy execution, the lifecycle state machine or the
 * broker adapters. It is carried through the whole async call chain by
 * an AsyncLocalStorage store, so no method signatures change and no
 * other broker flow (Shoonya / Fyers diagnostics / master-watcher) is
 * altered — a trace exists ONLY inside `ManualTradeService.place`.
 */

export interface ManualTradeTraceIds {
  manualTradeId: string | null;
  brokerOrderId: string | null;
  executionEventId: string | null;
  executionHistoryId: string | null;
  masterPositionId: string | null;
}

export interface ManualTradeTraceContext {
  correlationId: string;
  startedAtMs: number;
  ids: ManualTradeTraceIds;
  /** Every stage that emitted a trace line during this request. */
  stagesSeen: Set<number>;
  /** Stages proven to be reached FOR THE MANUAL ORDER specifically. */
  manualStages: Set<number>;

  broker: string | null;
  symbol: string | null;
  side: string | null;

  followerCount: number;
  executed: number;
  skipped: number;
  failed: number;

  manualStatus: string | null;
  tradeMonitorStatus: string | null;
  tradeMonitorIncluded: boolean | null;
  tradeMonitorFilterReason: string | null;
}

const storage = new AsyncLocalStorage<ManualTradeTraceContext>();
const traceLogger = new Logger('ManualTradeTrace');

// ---------------------------------------------------------------------------
// Correlation id — CTS-MT-YYYYMMDD-000001 (daily, in-process sequence)
// ---------------------------------------------------------------------------
let seqDate = '';
let seqCounter = 0;

export function nextCorrelationId(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const day = `${y}${m}${d}`;
  if (day !== seqDate) {
    seqDate = day;
    seqCounter = 0;
  }
  seqCounter += 1;
  return `CTS-MT-${day}-${String(seqCounter).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Context lifecycle
// ---------------------------------------------------------------------------
export function createManualTradeTraceContext(): ManualTradeTraceContext {
  return {
    correlationId: nextCorrelationId(),
    startedAtMs: Date.now(),
    ids: {
      manualTradeId: null,
      brokerOrderId: null,
      executionEventId: null,
      executionHistoryId: null,
      masterPositionId: null,
    },
    stagesSeen: new Set<number>(),
    manualStages: new Set<number>(),
    broker: null,
    symbol: null,
    side: null,
    followerCount: 0,
    executed: 0,
    skipped: 0,
    failed: 0,
    manualStatus: null,
    tradeMonitorStatus: null,
    tradeMonitorIncluded: null,
    tradeMonitorFilterReason: null,
  };
}

export function runWithManualTradeTrace<T>(
  ctx: ManualTradeTraceContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function currentManualTradeTrace(): ManualTradeTraceContext | undefined {
  return storage.getStore();
}

/** Mark a stage as reached specifically for the manual order. */
export function markManualStage(stage: number): void {
  storage.getStore()?.manualStages.add(stage);
}

// ---------------------------------------------------------------------------
// Stage logging
// ---------------------------------------------------------------------------
export interface StageLog {
  component: string;
  method: string;
  input?: unknown;
  output?: unknown;
  status: string;
  relatedIds?: Record<string, string | null | undefined>;
}

/**
 * Emit one structured stage line. A no-op when there is no active manual
 * trade trace (so the recorder / lifecycle / history services stay silent
 * for every non-manual event and other broker flows are unaffected).
 *
 * @param markManual  also record this stage against `manualStages` (used
 *                    for the summary's accurate "Missing Stage" — pass true
 *                    only when the stage is proven for the manual order).
 */
export function traceStage(
  stage: number,
  log: StageLog,
  markManual = false,
): void {
  const ctx = storage.getStore();
  if (!ctx) return;

  ctx.stagesSeen.add(stage);
  if (markManual) ctx.manualStages.add(stage);

  const elapsedMs = Date.now() - ctx.startedAtMs;
  const payload = {
    correlationId: ctx.correlationId,
    timestamp: new Date().toISOString(),
    stage,
    component: log.component,
    method: log.method,
    status: log.status,
    elapsedMs,
    input: log.input ?? null,
    output: log.output ?? null,
    relatedIds: log.relatedIds ?? {},
  };

  traceLogger.log(
    `[${ctx.correlationId}] STAGE ${stage} — ${log.component}.${log.method} :: ` +
      `${log.status} (+${elapsedMs}ms) ${safeJson(payload)}`,
  );
}

// ---------------------------------------------------------------------------
// Bounded wait for the fire-and-forget execution-history persistence, so the
// summary can report the ExecutionHistory ID. Does NOT change the recorder's
// fire-and-forget architecture — the manual request simply waits briefly for
// a complete diagnostic picture. Skipped entirely when no fan-out occurred.
// ---------------------------------------------------------------------------
export async function waitForPersistence(
  ctx: ManualTradeTraceContext,
  maxMs = 1800,
  stepMs = 150,
): Promise<void> {
  if (!ctx.ids.executionEventId) return; // no fan-out → nothing persisted
  const deadline = Date.now() + maxMs;
  while (!ctx.ids.executionHistoryId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------
const REQUIRED_STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function finalizeManualTradeTrace(ctx: ManualTradeTraceContext): void {
  const missing = REQUIRED_STAGES.find((s) => !ctx.manualStages.has(s));
  const coreReached = [1, 2, 3, 4, 5, 6, 7, 8, 9].every((s) =>
    ctx.manualStages.has(s),
  );
  const terminalOk =
    ctx.manualStatus === 'COMPLETED' || ctx.manualStatus === 'PARTIAL';
  const completed = coreReached && terminalOk;

  const lines = [
    '===================================================',
    'CTS MANUAL TRADE SUMMARY',
    '',
    `Correlation ID              : ${ctx.correlationId}`,
    `Manual Trade ID             : ${ctx.ids.manualTradeId ?? '—'}`,
    `Broker Order ID             : ${ctx.ids.brokerOrderId ?? '—'}`,
    `Execution Event ID          : ${ctx.ids.executionEventId ?? '—'}`,
    `Execution History ID        : ${ctx.ids.executionHistoryId ?? '—'}`,
    `Master Position ID          : ${ctx.ids.masterPositionId ?? '—'}`,
    `Follower Count              : ${ctx.followerCount}`,
    `Executed                    : ${ctx.executed}`,
    `Skipped                     : ${ctx.skipped}`,
    `Failed                      : ${ctx.failed}`,
    `Current Manual Status       : ${ctx.manualStatus ?? '—'}`,
    `Current Trade Monitor Status: ${ctx.tradeMonitorStatus ?? (ctx.tradeMonitorFilterReason ?? '—')}`,
    `Pipeline Completed          : ${completed ? 'YES' : 'NO'}`,
    `Missing Stage               : ${missing ? `${missing} (${STAGE_NAMES[missing]})` : 'NONE'}`,
    '===================================================',
  ];

  traceLogger.log(`\n${lines.join('\n')}`);
}

const STAGE_NAMES: Record<number, string> = {
  1: 'ManualTradeService.place — request received',
  2: 'ManualTradeValidatorService.validate',
  3: 'Broker adapter — order sent',
  4: 'ManualTradeService.fetchPlacedOrder',
  5: 'PositionLifecycleService.ingest',
  6: 'ExecutionEventRecorder',
  7: 'CopyTradingService fan-out',
  8: 'ExecutionHistoryService.persist',
  9: 'ManualTradeService.handleExecutionCommit',
  10: 'Trade Monitor query',
};

// ---------------------------------------------------------------------------
function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet();
    const str = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      if (typeof v === 'string' && v.length > 600) {
        return `${v.slice(0, 600)}…(+${v.length - 600})`;
      }
      return v;
    });
    if (str && str.length > 4000) return `${str.slice(0, 4000)}…(truncated)`;
    return str ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}
