/**
 * Centralized copy-trading execution result vocabulary.
 *
 * SINGLE source of truth for every follower-execution outcome category and the
 * standardized result envelope that broker adapters are normalized into before
 * they ever reach CopyTradingService. Previously the copy engine hard-coded a
 * supported-broker allow-list and emitted a small set of ad-hoc failure strings
 * (magic strings scattered across services). Every category now lives here so
 * the Trade Monitor / Execution History can badge the ACTUAL broker outcome
 * (Rejected by Broker, Token Expired, Insufficient Funds, AMO Not Supported, …)
 * instead of a generic FAILED.
 *
 * Backward compatible: the legacy `ExecutionFailureType` values still used by
 * `classifyFailure`, the manual-trade record and the admin UI badges are kept
 * verbatim in this union so nothing downstream regresses.
 */

export const ExecutionResultCategory = {
  // Terminal success.
  SUCCESS: 'SUCCESS',

  // Broker-side business rejections.
  REJECTED_BY_BROKER: 'REJECTED_BY_BROKER',
  BROKER_VALIDATION: 'BROKER_VALIDATION',
  RMS_REJECTION: 'RMS_REJECTION',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  PRODUCT_NOT_ALLOWED: 'PRODUCT_NOT_ALLOWED',
  AMO_NOT_SUPPORTED: 'AMO_NOT_SUPPORTED',
  SYMBOL_MAPPING_FAILED: 'SYMBOL_MAPPING_FAILED',

  // Auth / session.
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // Transport / availability (retryable).
  NETWORK_FAILURE: 'NETWORK_FAILURE',
  BROKER_TIMEOUT: 'BROKER_TIMEOUT',
  BROKER_UNAVAILABLE: 'BROKER_UNAVAILABLE',
  BROKER_RATE_LIMIT: 'BROKER_RATE_LIMIT',

  // Fallback broker error.
  UNKNOWN_BROKER_ERROR: 'UNKNOWN_BROKER_ERROR',

  // Non-execution outcomes (skips).
  SKIPPED: 'SKIPPED',
  BROKER_UNSUPPORTED: 'BROKER_UNSUPPORTED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  FOLLOWER_DISABLED: 'FOLLOWER_DISABLED',
  COPY_DISABLED: 'COPY_DISABLED',
  NO_BROKER_SESSION: 'NO_BROKER_SESSION',

  // ---- Legacy values (kept for backward compatibility) ----
  ORDER_REJECTED: 'ORDER_REJECTED',
  IP_WHITELIST: 'IP_WHITELIST',
  INSTRUMENT_NOT_FOUND: 'INSTRUMENT_NOT_FOUND',
  BROKER_ERROR: 'BROKER_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  SYMBOL_MAPPING_MISSING: 'SYMBOL_MAPPING_MISSING',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ExecutionResultCategory =
  (typeof ExecutionResultCategory)[keyof typeof ExecutionResultCategory];

/** Categories that are safe to retry automatically (transient transport). */
const RETRYABLE_CATEGORIES: ReadonlySet<ExecutionResultCategory> = new Set([
  ExecutionResultCategory.NETWORK_FAILURE,
  ExecutionResultCategory.BROKER_TIMEOUT,
  ExecutionResultCategory.BROKER_UNAVAILABLE,
  ExecutionResultCategory.BROKER_RATE_LIMIT,
]);

export function isRetryable(category: ExecutionResultCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

/** Categories that represent a non-execution (skip) rather than a failure. */
const SKIP_CATEGORIES: ReadonlySet<ExecutionResultCategory> = new Set([
  ExecutionResultCategory.SKIPPED,
  ExecutionResultCategory.BROKER_UNSUPPORTED,
  ExecutionResultCategory.ACCOUNT_DISABLED,
  ExecutionResultCategory.FOLLOWER_DISABLED,
  ExecutionResultCategory.COPY_DISABLED,
  ExecutionResultCategory.NO_BROKER_SESSION,
]);

export type FollowerRecorderStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';

/** Map a result category onto the recorder's follower lifecycle status. */
export function mapCategoryToStatus(
  category: ExecutionResultCategory,
): FollowerRecorderStatus {
  if (category === ExecutionResultCategory.SUCCESS) return 'SUCCESS';
  if (SKIP_CATEGORIES.has(category)) return 'SKIPPED';
  return 'FAILED';
}

/**
 * Standardized broker execution result. Every broker adapter response (and
 * every thrown adapter error) is normalized into THIS shape before it reaches
 * CopyTradingService, so the copy engine never sees a broker-specific payload.
 */
export interface StandardExecutionResult {
  broker: string;
  success: boolean;
  category: ExecutionResultCategory;
  retryable: boolean;

  brokerOrderId: string | null;
  exchangeOrderId: string | null;
  httpStatus: number | null;
  brokerStatus: string | null;
  brokerMessage: string | null;
  failureReason: string | null;

  latencyMs: number | null;
  executionTime: string;

  orderRequest: unknown | null;
  translatedSymbol: string | null;

  followerAccountId: string | null;
  followerId: string | null;
  correlationId: string | null;

  /** Verbatim broker response / error snapshot (never fabricated). */
  rawResponse: unknown | null;
}
