import { Broker } from '@prisma/client';

/**
 * Sprint 5.4 — Manual Trade Execution.
 *
 * Types describing an admin-initiated master trade as it travels
 * through the platform's existing execution pipeline:
 *
 *   Admin UI  →  Manual Trade API  →  Master BrokerAdapter
 *             →  PositionLifecycleService.ingest (same pipeline as
 *                broker-detected trades)
 *             →  CopyTradingService (fan-out with tradeSource=MANUAL)
 *             →  ExecutionHistory / Trade Monitor
 */

/**
 * Life-cycle status of a manual trade request kept in the manual
 * trading in-memory ledger. Progresses monotonically from PENDING to
 * a terminal state.
 *
 *  PENDING              — request accepted by the API, validating.
 *  ACCEPTED             — master broker accepted the order.
 *  REJECTED             — master broker rejected the order at placement.
 *  EXECUTING_FOLLOWERS  — order is being fanned out to followers.
 *  COMPLETED            — every enabled follower succeeded.
 *  PARTIAL              — some followers succeeded, some did not.
 *  FAILED               — all follower attempts failed / master rejected.
 */
export enum ManualTradeStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EXECUTING_FOLLOWERS = 'EXECUTING_FOLLOWERS',
  COMPLETED = 'COMPLETED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

/** Product tags supported by the manual trade form. */
export type ManualTradeProduct = 'CNC' | 'MIS' | 'NRML';

/** Order types supported by the manual trade form. */
export type ManualTradeOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

/** Order validities supported by the manual trade form. */
export type ManualTradeValidity = 'DAY' | 'IOC';

/** Transaction sides supported by the manual trade form. */
export type ManualTradeSide = 'BUY' | 'SELL';

/**
 * A pre-flight validation check result, structurally identical to the
 * StrategyExecutionService / TradeEventValidationService shape so
 * operators see a consistent format across every pipeline.
 */
export type ManualTradeValidationKey =
  | 'master_account_exists'
  | 'master_account_connected'
  | 'broker_session_healthy'
  | 'strategy_active'
  | 'strategy_belongs_to_master'
  | 'strategy_has_enabled_followers'
  | 'instrument_exists'
  | 'broker_symbol_mapping_exists'
  | 'required_fields_present';

export interface ManualTradeValidationCheck {
  key: ManualTradeValidationKey;
  ok: boolean;
  message: string;
}

export interface ManualTradeValidationResult {
  ok: boolean;
  checks: ManualTradeValidationCheck[];
  errors: ManualTradeValidationCheck[];
  validatedAt: string;
}

/**
 * A single follower outcome extracted from the ExecutionEvent that
 * CopyTradingService committed for this manual trade. Kept in the
 * manual trade ledger so the UI can render "Executing Followers"
 * status without having to join execution_history.
 */
export interface ManualTradeFollowerOutcome {
  followerId: string;
  followerEmail: string;
  broker: string;
  status: 'PENDING' | 'EXECUTING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  failureType: string | null;
  reason: string | null;
  followerSymbol: string | null;
  quantity: number | null;
  brokerOrderId: string | null;
}

/**
 * Immutable record of a single manual trade attempt. Populated at
 * placement time and enriched by the execution-event subscription
 * once the CopyTradingService fan-out commits.
 */
export interface ManualTradeRecord {
  id: string;

  masterAccountId: string;
  masterAccountName: string | null;
  strategyId: string;
  strategyName: string | null;

  broker: Broker;
  exchange: string;
  symbol: string;
  side: ManualTradeSide;
  orderType: ManualTradeOrderType;
  quantity: number;
  product: ManualTradeProduct;
  price: number | null;
  triggerPrice: number | null;
  validity: ManualTradeValidity;

  status: ManualTradeStatus;

  /** Broker-side order id when the master accepted the order. */
  brokerOrderId: string | null;
  /** Verbatim adapter response for the master placement call. */
  brokerResponse: unknown | null;
  /** Reason surfaced when status = REJECTED / FAILED. */
  rejectionReason: string | null;
  /**
   * Structural classification of the failure surface — reuses the
   * ExecutionFailureType vocabulary the copy-trading recorder emits
   * (ORDER_REJECTED, TOKEN_EXPIRED, IP_WHITELIST, BROKER_ERROR, …) so
   * the UI can badge / filter without regex-ing the raw message.
   */
  failureType: string | null;
  /**
   * Stage at which the trade failed. Populated only when status is
   * REJECTED or FAILED — one of:
   *   - `local_validation`  → shape / required-field DTO rejection
   *   - `preflight_validation` → structural pre-flight validator (a check failed)
   *   - `broker_placement`  → master broker rejected the order
   *   - `broker_error`      → adapter threw during the placement call
   *   - `fan_out`           → CopyTradingService fan-out surfaced errors
   */
  failureStage: string | null;

  /** Validation snapshot rendered next to the entry in the UI. */
  validation: ManualTradeValidationResult;

  /** ExecutionEvent id linked to this manual trade once fan-out fires. */
  executionEventId: string | null;

  followersFound: number;
  followers: ManualTradeFollowerOutcome[];
  successfulFollowers: number;
  failedFollowers: number;
  skippedFollowers: number;

  createdAt: string;
  updatedAt: string;
}

export interface ManualTradeListResponse {
  count: number;
  items: ManualTradeRecord[];
}
