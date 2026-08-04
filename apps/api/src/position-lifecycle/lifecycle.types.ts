import { Broker } from '@prisma/client';

/**
 * Sprint 5.3 — Order & Position Lifecycle types.
 *
 * These types describe the internal lifecycle model that the platform
 * uses to represent every broker-side transition on a master order and
 * to keep follower orders synchronized until the position is fully
 * closed. The lifecycle vocabulary is broker-agnostic — every broker
 * adapter normalizes into this shape.
 *
 * This is deliberately additive to the existing intake pipeline
 * (`trade-events`) and copy-trading fan-out (`copy-trading`). The
 * lifecycle model does not replace either — it composes them.
 */

/**
 * Vocabulary of lifecycle events emitted by the broker normalizer.
 *
 *  NEW              – order accepted by the exchange, awaiting fill.
 *  PARTIAL_FILL     – additional quantity filled; not yet complete.
 *  COMPLETE_FILL    – fully filled (a.k.a. "trade booked").
 *  ORDER_MODIFY     – open order was modified (qty / price / trigger).
 *  STOP_LOSS_MODIFY – stop-loss leg of a bracket / cover order changed.
 *  TARGET_MODIFY    – target leg of a bracket / cover order changed.
 *  CANCEL           – open order cancelled before it filled.
 *  EXIT             – the master issued a reverse order that closes an
 *                     open position (broker terminology varies).
 *  POSITION_CLOSED  – the net position on the instrument reached zero.
 *  REJECT           – broker rejected the order at any point.
 */
export enum LifecycleEventType {
  NEW = 'NEW',
  PARTIAL_FILL = 'PARTIAL_FILL',
  COMPLETE_FILL = 'COMPLETE_FILL',
  ORDER_MODIFY = 'ORDER_MODIFY',
  STOP_LOSS_MODIFY = 'STOP_LOSS_MODIFY',
  TARGET_MODIFY = 'TARGET_MODIFY',
  CANCEL = 'CANCEL',
  EXIT = 'EXIT',
  POSITION_CLOSED = 'POSITION_CLOSED',
  REJECT = 'REJECT',
}

/**
 * Position-level state machine. Only these states are legal
 * representations of a master position inside the registry.
 *
 *  PENDING           – NEW seen, no fills yet.
 *  PARTIALLY_FILLED  – at least one PARTIAL_FILL, not yet complete.
 *  OPEN              – fully filled and the position is open.
 *  CANCELLED         – order cancelled before any fill.
 *  REJECTED          – broker rejected the order.
 *  EXITING           – exit order placed; awaiting exchange confirmation.
 *  CLOSED            – position closed (or POSITION_CLOSED received).
 */
export enum PositionState {
  PENDING = 'PENDING',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  OPEN = 'OPEN',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
  EXITING = 'EXITING',
  CLOSED = 'CLOSED',
}

export type LifecycleSide = 'BUY' | 'SELL';

/**
 * Canonical, broker-agnostic lifecycle event produced by the
 * broker-lifecycle normalizer. One raw broker order object may
 * produce zero events (unchanged since last poll) or one event
 * per detected transition.
 */
export interface LifecycleEvent {
  type: LifecycleEventType;

  broker: Broker;
  masterAccountId: string;
  brokerOrderId: string;

  symbol: string;
  exchange: string | null;
  side: LifecycleSide;

  /** Total quantity on the order (after any modification). */
  quantity: number;
  /** Cumulative filled quantity as reported by the broker. */
  filledQuantity: number;
  /** Remaining open quantity (quantity - filledQuantity). */
  pendingQuantity: number;

  /** Average execution price if available, else limit/trigger price. */
  price: number | null;
  /** Stop-loss / trigger price if the broker reports it. */
  triggerPrice: number | null;

  orderType: string | null;
  productType: string | null;
  rawStatus: string | null;

  /** Broker-reported update timestamp, or null when unavailable. */
  brokerUpdatedAt: string | null;

  /** Free-form reason attached by the broker (e.g. rejection text). */
  reason: string | null;

  /** Verbatim broker payload for audit purposes. */
  raw: unknown;
}

/**
 * Deduplication signature computed from a raw broker order. Two
 * consecutive normalizations that yield the same signature describe
 * the same known state and are treated as no-ops.
 */
export interface OrderSignature {
  status: string;
  filledQuantity: number;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  brokerUpdatedAt: string | null;
}

export interface LifecycleTimelineEntry {
  at: string;
  kind: string;
  label: string;
  details?: Record<string, unknown>;
}

/**
 * A follower order that mirrors a master position. Recorded by the
 * registry when the copy-trading service reports a successful fan-out
 * so that later lifecycle events (modify / cancel / exit) know which
 * follower orders to act on.
 */
export interface FollowerOrderLink {
  followerAccountId: string;
  followerId: string | null;
  followerEmail: string | null;
  broker: Broker;
  brokerOrderId: string;
  followerSymbol: string | null;
  quantity: number | null;
  createdAt: string;
  lastAction: string;
  lastActionAt: string;
  lastActionOk: boolean;
  lastActionMessage: string | null;
}

/**
 * A single tracked master position and the follower orders that
 * currently mirror it. The registry key is `{broker}:{masterAccountId}:{brokerOrderId}`.
 */
export interface PositionRecord {
  key: string;
  broker: Broker;
  masterAccountId: string;
  brokerOrderId: string;

  strategyId: string | null;
  symbol: string;
  exchange: string | null;
  side: LifecycleSide;

  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  price: number | null;
  triggerPrice: number | null;
  productType: string | null;
  orderType: string | null;

  state: PositionState;

  /** Last raw signature we processed for this order (dedup gate). */
  lastSignature: OrderSignature | null;

  timeline: LifecycleTimelineEntry[];
  followers: FollowerOrderLink[];

  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/**
 * Outcome of a single follower synchronization attempt.
 */
export interface FollowerSyncOutcome {
  followerAccountId: string;
  followerEmail: string | null;
  brokerOrderId: string | null;
  ok: boolean;
  action: 'MODIFY' | 'CANCEL' | 'EXIT';
  reason: string | null;
  brokerResponse: unknown | null;
}

/**
 * Outcome of one lifecycle ingestion (a single normalized broker
 * order pushed through the manager). Returned to callers so that
 * upstream listeners can log or audit what happened.
 */
export interface LifecycleIngestOutcome {
  key: string;
  accepted: boolean;
  event: LifecycleEvent | null;
  previousState: PositionState | null;
  nextState: PositionState | null;
  reason: string | null;
  followerSync: FollowerSyncOutcome[];
}
