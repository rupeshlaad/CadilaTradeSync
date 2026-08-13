/**
 * Real copy-trading execution telemetry.
 *
 * These types describe an actually-executed pass of `CopyTradingService.handleTrade`
 * — one master trade fanned out to N followers. There is exactly one
 * ExecutionEvent per invocation of `handleTrade`, recorded in-memory by
 * `ExecutionEventRecorderService` so the admin Trade Monitor can visualise
 * the real broker fan-out without a database schema change.
 *
 * The recorder is deliberately additive: it never influences broker calls,
 * ordering, retries, or logging behaviour in CopyTradingService.
 */

import type { ExecutionResultCategory } from './execution-result-category';

/** Per-follower lifecycle status inside a single master-trade fan-out. */
export type ExecutionFollowerStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'SUCCESS'
  | 'FAILED'
  | 'SKIPPED';

/**
 * High-level classification of a per-follower outcome so the admin UI can
 * badge / filter without regex-ing free-form reason strings. Now aliased to
 * the centralized {@link ExecutionResultCategory} (single source of truth) — a
 * strict superset of the legacy values, so nothing downstream regresses.
 */
export type ExecutionFailureType = ExecutionResultCategory;

export interface FollowerExecution {
  /** Local record id (not the follower's DB id — use `followerId` for that). */
  id: string;
  followerId: string;
  followerName: string;
  followerEmail: string;
  followerAccountId: string;
  broker: string;

  status: ExecutionFollowerStatus;
  failureType: ExecutionFailureType | null;
  reason: string | null;

  /** Verbatim response payload from the broker adapter (or error object). */
  brokerResponse: unknown | null;
  followerSymbol: string | null;
  quantity: number | null;

  // ---------------------------------------------------------------------
  // Sprint — standardized broker execution result recording (additive).
  // Populated by FollowerExecutionHandle.recordStandardResult from the
  // broker-neutral StandardExecutionResult so Trade Monitor / Execution
  // History can surface the ACTUAL broker outcome, not just SUCCESS/FAILED.
  // All optional → existing producers/consumers are unaffected.
  // ---------------------------------------------------------------------
  category?: string | null;
  retryable?: boolean | null;
  brokerOrderId?: string | null;
  exchangeOrderId?: string | null;
  httpStatus?: number | null;
  brokerStatus?: string | null;
  brokerMessage?: string | null;
  latencyMs?: number | null;
  orderRequest?: unknown | null;
  correlationId?: string | null;

  startedAt: string;
  completedAt: string | null;
}

export interface ExecutionEvent {
  id: string;
  timestamp: string;

  strategyId: string | null;
  strategyName: string | null;

  masterAccountId: string;
  masterAccountNickname: string | null;
  broker: string;

  /**
   * Broker-side order id on the master account, when the caller
   * forwarded one (real broker polls / postbacks always do; synthetic
   * or manual events may pass null). Used by the position-lifecycle
   * registry (Sprint 5.3) to correlate follower broker order ids with
   * a tracked master position.
   */
  masterBrokerOrderId: string | null;

  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number | null;
  productType: string;
  orderType: string | null;
  tradeSource: string;

  masterExchange: string | null;
  masterSegment: string | null;

  followersFound: number;
  followers: FollowerExecution[];

  /** Terminal reason when the master trade never reached follower fan-out. */
  outcome:
    | 'NO_ACTIVE_STRATEGY'
    | 'NO_ENABLED_FOLLOWERS'
    | 'FANNED_OUT'
    | 'ERROR';

  /** Set on outcome=ERROR — captures a top-level exception in handleTrade. */
  errorReason: string | null;

  /** Elapsed milliseconds from `begin()` to `commit()`. */
  processingTimeMs: number | null;
}

/**
 * Rolling counters + a slice of recent events, used by the admin summary
 * card in the Trade Monitor page. All counters are derived from the same
 * in-memory buffer so they never drift from the table.
 */
export interface ExecutionEventSummary {
  totalRecorded: number;
  bufferSize: number;
  bufferCapacity: number;
  today: {
    events: number;
    successfulOrders: number;
    failedOrders: number;
    pendingOrders: number;
    followersExecuted: number;
  };
  latest: ExecutionEvent | null;
}
