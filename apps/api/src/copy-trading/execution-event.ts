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

/** Per-follower lifecycle status inside a single master-trade fan-out. */
export type ExecutionFollowerStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'SUCCESS'
  | 'FAILED'
  | 'SKIPPED';

/**
 * High-level classification of a per-follower failure so the admin UI can
 * badge / filter without regex-ing free-form reason strings. Values are
 * derived from the real error surface of CopyTradingService and the
 * broker adapters currently wired in.
 */
export type ExecutionFailureType =
  | 'ORDER_REJECTED'
  | 'IP_WHITELIST'
  | 'INSTRUMENT_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'BROKER_ERROR'
  | 'VALIDATION_FAILED'
  | 'BROKER_UNSUPPORTED'
  | 'NO_BROKER_SESSION'
  | 'SYMBOL_MAPPING_MISSING'
  | 'UNKNOWN';

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
