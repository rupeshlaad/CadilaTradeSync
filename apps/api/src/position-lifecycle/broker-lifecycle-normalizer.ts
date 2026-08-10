import { Broker } from '@prisma/client';

import {
  LifecycleEvent,
  LifecycleEventType,
  LifecycleSide,
  OrderSignature,
} from './lifecycle.types';

/**
 * Sprint 5.3 — Broker → canonical Lifecycle event normalization.
 *
 * Every broker adapter reports order status with its own vocabulary.
 * This module converts the raw order objects we already fetch (via
 * `ZerodhaAdapter.getOrders()` / `FyersAdapter.getOrders()`) into the
 * canonical `LifecycleEvent` shape consumed by the lifecycle manager.
 *
 * The normalizer is pure: it does not persist anything, does not call
 * broker APIs, and does not decide what to do next. It only maps
 * broker-specific fields into the canonical vocabulary and computes
 * the deduplication signature.
 */

/** Broker-side status buckets we understand. Anything else becomes null. */
type NormalizedStatus =
  | 'NEW'
  | 'OPEN'
  | 'PARTIAL'
  | 'COMPLETE'
  | 'MODIFIED'
  | 'CANCELLED'
  | 'REJECTED';

export interface NormalizerContext {
  broker: Broker;
  masterAccountId: string;
}

export interface NormalizedRawOrder {
  brokerOrderId: string;
  status: NormalizedStatus | null;
  symbol: string;
  exchange: string | null;
  side: LifecycleSide;
  quantity: number;
  filledQuantity: number;
  price: number | null;
  triggerPrice: number | null;
  orderType: string | null;
  productType: string | null;
  brokerUpdatedAt: string | null;
  reason: string | null;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a broker-specific order object into a canonical shape,
 * decoupled from any lifecycle decision. Returns null if the payload
 * cannot be safely interpreted (missing order id / missing side).
 */
export function normalizeRawOrder(
  broker: Broker,
  raw: any,
): NormalizedRawOrder | null {
  if (!raw || typeof raw !== 'object') return null;

  if (broker === Broker.ZERODHA) return normalizeZerodha(raw);
  if (broker === Broker.FYERS) return normalizeFyers(raw);
  if (broker === Broker.SHOONYA) return normalizeShoonya(raw);
  if (broker === Broker.ICICI_DIRECT) return normalizeIcici(raw);
  if (broker === Broker.UPSTOX) return normalizeUpstox(raw);
  return null;
}

/**
 * Compute a stable deduplication signature so we can drop broker
 * echoes that carry no state change. Two consecutive normalizations
 * with the same signature are treated as no-ops by the lifecycle
 * manager.
 */
export function computeSignature(
  order: NormalizedRawOrder,
): OrderSignature {
  return {
    status: order.status ?? 'UNKNOWN',
    filledQuantity: order.filledQuantity,
    quantity: order.quantity,
    price: order.price,
    triggerPrice: order.triggerPrice,
    brokerUpdatedAt: order.brokerUpdatedAt,
  };
}

/**
 * Decide which lifecycle event(s) a normalized order represents given
 * the previously-observed signature (or null for a first sighting).
 * Returns the emitted events in the order they should be applied.
 *
 * The lifecycle manager applies them in sequence through the state
 * machine so a single COMPLETE_FILL after an unseen order still walks
 * PENDING → OPEN cleanly if we choose to emit both. This function
 * emits at most ONE event per invocation — the terminal event that
 * best describes the current broker view — because emitting multiple
 * would create ambiguous audit trails when the ingestion is polled.
 */
export function deriveLifecycleEvent(
  ctx: NormalizerContext,
  order: NormalizedRawOrder,
  previous: OrderSignature | null,
): LifecycleEvent | null {
  const type = classifyEvent(order, previous);
  if (!type) return null;

  return {
    type,
    broker: ctx.broker,
    masterAccountId: ctx.masterAccountId,
    brokerOrderId: order.brokerOrderId,
    symbol: order.symbol,
    exchange: order.exchange,
    side: order.side,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    pendingQuantity: Math.max(0, order.quantity - order.filledQuantity),
    price: order.price,
    triggerPrice: order.triggerPrice,
    orderType: order.orderType,
    productType: order.productType,
    rawStatus: order.status,
    brokerUpdatedAt: order.brokerUpdatedAt,
    reason: order.reason,
    raw: order.raw,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyEvent(
  order: NormalizedRawOrder,
  previous: OrderSignature | null,
): LifecycleEventType | null {
  const status = order.status;
  if (!status) return null;

  if (status === 'REJECTED') return LifecycleEventType.REJECT;
  if (status === 'CANCELLED') return LifecycleEventType.CANCEL;

  if (status === 'COMPLETE') {
    if (previous && previous.status === 'COMPLETE') {
      // No change — emit nothing.
      return null;
    }
    return LifecycleEventType.COMPLETE_FILL;
  }

  if (status === 'PARTIAL') {
    if (
      previous &&
      previous.status === 'PARTIAL' &&
      previous.filledQuantity === order.filledQuantity
    ) {
      return null;
    }
    return LifecycleEventType.PARTIAL_FILL;
  }

  if (status === 'MODIFIED') {
    return LifecycleEventType.ORDER_MODIFY;
  }

  if (status === 'OPEN' || status === 'NEW') {
    if (!previous) return LifecycleEventType.NEW;

    // We've seen this order before. If any of price / triggerPrice /
    // quantity changed we treat it as an order modification.
    const quantityChanged = previous.quantity !== order.quantity;
    const priceChanged = previous.price !== order.price;
    const triggerChanged = previous.triggerPrice !== order.triggerPrice;

    if (triggerChanged && !quantityChanged && !priceChanged) {
      // A pure trigger-price change is best represented as a stop-loss
      // modification. Consumers can further specialise on orderType if
      // they wish; for the lifecycle audit STOP_LOSS_MODIFY is the
      // closest match.
      return LifecycleEventType.STOP_LOSS_MODIFY;
    }
    if (priceChanged && !quantityChanged && !triggerChanged) {
      // Pure limit-price change on a target order is best represented
      // as a target-price modification.
      if ((order.orderType ?? '').toUpperCase().includes('LIMIT')) {
        return LifecycleEventType.TARGET_MODIFY;
      }
      return LifecycleEventType.ORDER_MODIFY;
    }
    if (quantityChanged || priceChanged || triggerChanged) {
      return LifecycleEventType.ORDER_MODIFY;
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Broker-specific mappers
// ---------------------------------------------------------------------------

/**
 * Zerodha (Kite Connect) order shape mapping.
 * Reference statuses: OPEN, TRIGGER PENDING, VALIDATION PENDING,
 * COMPLETE, CANCELLED, REJECTED, MODIFY VALIDATION PENDING, MODIFY
 * PENDING, PARTIALLY FILLED, PUT ORDER REQ RECEIVED.
 */
function normalizeZerodha(raw: any): NormalizedRawOrder | null {
  const orderId = raw.order_id != null ? String(raw.order_id) : null;
  if (!orderId) return null;

  const side = normalizeSide(
    raw.transaction_type ?? raw.side ?? raw.buy_or_sell,
  );
  if (!side) return null;

  return {
    brokerOrderId: orderId,
    status: mapZerodhaStatus(String(raw.status ?? '').toUpperCase()),
    symbol: String(raw.tradingsymbol ?? raw.symbol ?? '').trim(),
    exchange: raw.exchange ? String(raw.exchange) : null,
    side,
    quantity: safeNumber(raw.quantity),
    filledQuantity: safeNumber(raw.filled_quantity),
    price: nullableNumber(raw.average_price ?? raw.price),
    triggerPrice: nullableNumber(raw.trigger_price),
    orderType: raw.order_type ? String(raw.order_type) : null,
    productType: raw.product ? String(raw.product) : null,
    brokerUpdatedAt: firstIso(
      raw.exchange_update_timestamp,
      raw.order_timestamp,
    ),
    reason:
      typeof raw.status_message === 'string' && raw.status_message.trim()
        ? raw.status_message.trim()
        : null,
    raw,
  };
}

function mapZerodhaStatus(status: string): NormalizedStatus | null {
  if (!status) return null;
  if (status === 'COMPLETE') return 'COMPLETE';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'REJECTED') return 'REJECTED';
  if (status.startsWith('MODIFY')) return 'MODIFIED';
  if (status.includes('PARTIAL')) return 'PARTIAL';
  if (status === 'OPEN' || status === 'PUT ORDER REQ RECEIVED')
    return 'OPEN';
  if (status.includes('PENDING')) return 'OPEN';
  return null;
}

/**
 * Fyers order shape mapping.
 * Fyers `status` codes: 1 = Cancelled, 2 = Traded / Filled,
 * 3 = For future use, 4 = Transit, 5 = Rejected, 6 = Pending,
 * 7 = Expired.
 */
function normalizeFyers(raw: any): NormalizedRawOrder | null {
  const orderId = raw.id != null ? String(raw.id) : null;
  if (!orderId) return null;

  const side = normalizeSide(raw.side);
  if (!side) return null;

  return {
    brokerOrderId: orderId,
    status: mapFyersStatus(raw.status),
    symbol: String(raw.symbol ?? '').trim(),
    exchange: raw.exchange ? String(raw.exchange) : null,
    side,
    quantity: safeNumber(raw.qty),
    filledQuantity: safeNumber(raw.filledQty),
    price: nullableNumber(raw.tradedPrice ?? raw.limitPrice),
    triggerPrice: nullableNumber(raw.stopPrice),
    orderType: raw.type != null ? String(raw.type) : null,
    productType: raw.productType ? String(raw.productType) : null,
    brokerUpdatedAt: firstIso(raw.orderDateTime, raw.orderNumStatus),
    reason:
      typeof raw.message === 'string' && raw.message.trim()
        ? raw.message.trim()
        : null,
    raw,
  };
}

function mapFyersStatus(status: unknown): NormalizedStatus | null {
  const n = typeof status === 'number' ? status : Number(status);
  if (!Number.isFinite(n)) return null;
  switch (n) {
    case 1:
      return 'CANCELLED';
    case 2:
      return 'COMPLETE';
    case 4:
      return 'OPEN';
    case 5:
      return 'REJECTED';
    case 6:
      return 'OPEN';
    case 7:
      return 'REJECTED';
    default:
      return null;
  }
}

/**
 * Shoonya order shape mapping — supported for lifecycle detection
 * only (execution fan-out today remains Fyers-only, MVP).
 */
function normalizeShoonya(raw: any): NormalizedRawOrder | null {
  const orderId = raw.norenordno != null ? String(raw.norenordno) : null;
  if (!orderId) return null;
  const side = normalizeSide(raw.trantype ?? raw.side);
  if (!side) return null;

  return {
    brokerOrderId: orderId,
    status: mapShoonyaStatus(String(raw.status ?? '').toUpperCase()),
    symbol: String(raw.tsym ?? raw.symbol ?? '').trim(),
    exchange: raw.exch ? String(raw.exch) : null,
    side,
    quantity: safeNumber(raw.qty),
    filledQuantity: safeNumber(raw.fillshares),
    price: nullableNumber(raw.avgprc ?? raw.prc),
    triggerPrice: nullableNumber(raw.trgprc),
    orderType: raw.prctyp ? String(raw.prctyp) : null,
    productType: raw.prd ? String(raw.prd) : null,
    brokerUpdatedAt: null,
    reason: raw.rejreason ? String(raw.rejreason) : null,
    raw,
  };
}

function mapShoonyaStatus(status: string): NormalizedStatus | null {
  if (!status) return null;
  if (status === 'COMPLETE') return 'COMPLETE';
  if (status === 'CANCELED' || status === 'CANCELLED') return 'CANCELLED';
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'OPEN' || status === 'TRIGGER_PENDING') return 'OPEN';
  if (status === 'PARTIALLY_FILLED') return 'PARTIAL';
  return null;
}

/**
 * ICICI Direct (Breeze) order shape mapping. Sprint 6.2.8 — this branch was
 * MISSING entirely, so every ICICI order (including manual placements routed
 * through the lifecycle) normalized to null and never reached the copy engine.
 * That was the root cause of "trades executed directly in ICICI are not
 * detected" AND of ICICI manual trades never fanning out to followers.
 *
 * Breeze `order` (order_list) fields: order_id, stock_code, exchange_code,
 * action (Buy/Sell), quantity, pending_quantity, price, average_price,
 * stoploss, order_type, product, validity, status, order_datetime.
 * filledQuantity = quantity − pending_quantity.
 */
function normalizeIcici(raw: any): NormalizedRawOrder | null {
  const orderId = raw.order_id != null ? String(raw.order_id) : null;
  if (!orderId) return null;

  const side = normalizeSide(raw.action ?? raw.side);
  if (!side) return null;

  const quantity = safeNumber(raw.quantity);
  const pending = safeNumber(raw.pending_quantity);
  const filled = Math.max(0, quantity - pending);

  return {
    brokerOrderId: orderId,
    status: mapIciciStatus(String(raw.status ?? '').trim()),
    symbol: String(raw.stock_code ?? raw.symbol ?? '').trim(),
    exchange: raw.exchange_code ? String(raw.exchange_code) : null,
    side,
    quantity,
    filledQuantity: filled,
    price: nullableNumber(raw.average_price ?? raw.price),
    triggerPrice: nullableNumber(raw.stoploss),
    orderType: raw.order_type ? String(raw.order_type) : null,
    productType: raw.product ? String(raw.product) : null,
    brokerUpdatedAt: firstIso(raw.order_datetime, raw.exchange_acknowledgement_date),
    reason:
      typeof raw.message === 'string' && raw.message.trim()
        ? raw.message.trim()
        : typeof raw.reject_reason === 'string' && raw.reject_reason.trim()
        ? raw.reject_reason.trim()
        : null,
    raw,
  };
}

function mapIciciStatus(status: string): NormalizedStatus | null {
  const s = status.toUpperCase();
  if (!s) return null;
  if (s === 'EXECUTED' || s === 'COMPLETE') return 'COMPLETE';
  if (s === 'PARTIALLY EXECUTED' || s.includes('PARTIAL')) return 'PARTIAL';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  if (s === 'REJECTED' || s === 'EXPIRED') return 'REJECTED';
  if (s === 'ORDERED' || s === 'REQUESTED' || s === 'QUEUED' || s === 'FRESH')
    return 'OPEN';
  return null;
}

// ---------------------------------------------------------------------------
// Upstox (Uplink v2) order shape mapping. Sprint 6.3.
//
// Upstox `/order/retrieve-all` fields: order_id, tradingsymbol, exchange,
// transaction_type (BUY/SELL), quantity, filled_quantity, price,
// average_price, trigger_price, order_type, product, status, status_message,
// order_timestamp. Status vocabulary: "open", "complete", "cancelled",
// "rejected", "trigger pending", "validation pending", "put order req
// received", "modify validation pending", "open pending", "after market
// order req received".
// ---------------------------------------------------------------------------
function normalizeUpstox(raw: any): NormalizedRawOrder | null {
  const orderId = raw.order_id != null ? String(raw.order_id) : null;
  if (!orderId) return null;

  const side = normalizeSide(raw.transaction_type ?? raw.side);
  if (!side) return null;

  const quantity = safeNumber(raw.quantity);
  const filled = safeNumber(raw.filled_quantity);
  let status = mapUpstoxStatus(String(raw.status ?? '').trim());
  // Upstox reports partial fills as "open" with a non-zero filled_quantity.
  if (status === 'OPEN' && filled > 0 && filled < quantity) status = 'PARTIAL';

  return {
    brokerOrderId: orderId,
    status,
    symbol: String(raw.tradingsymbol ?? raw.symbol ?? '').trim(),
    exchange: raw.exchange ? String(raw.exchange) : null,
    side,
    quantity,
    filledQuantity: filled,
    price: nullableNumber(raw.average_price ?? raw.price),
    triggerPrice: nullableNumber(raw.trigger_price),
    orderType: raw.order_type ? String(raw.order_type) : null,
    productType: raw.product ? String(raw.product) : null,
    brokerUpdatedAt: firstIso(raw.order_timestamp, raw.exchange_timestamp),
    reason:
      typeof raw.status_message === 'string' && raw.status_message.trim()
        ? raw.status_message.trim()
        : null,
    raw,
  };
}

function mapUpstoxStatus(status: string): NormalizedStatus | null {
  const s = status.toUpperCase();
  if (!s) return null;
  if (s === 'COMPLETE' || s === 'COMPLETED') return 'COMPLETE';
  if (s.includes('CANCEL')) return 'CANCELLED';
  if (s.includes('REJECT')) return 'REJECTED';
  if (s.includes('MODIFY')) return 'MODIFIED';
  if (s === 'OPEN' || s.includes('PENDING') || s.includes('RECEIVED') || s.includes('VALIDATION') || s.includes('TRIGGER'))
    return 'OPEN';
  return null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function normalizeSide(v: unknown): LifecycleSide | null {
  if (v === 1 || v === '1') return 'BUY';
  if (v === -1 || v === '-1') return 'SELL';
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'BUY' || s === 'B') return 'BUY';
  if (s === 'SELL' || s === 'S') return 'SELL';
  return null;
}

function safeNumber(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nullableNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstIso(...values: unknown[]): string | null {
  for (const v of values) {
    if (!v) continue;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
      return v;
    }
  }
  return null;
}
