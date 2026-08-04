import { Broker } from '@prisma/client';

import {
  ManualTradeOrderType,
  ManualTradeProduct,
} from './manual-trade.types';

/**
 * Sprint 5.4.2 — Broker-aware manual-trading rules.
 *
 * Single source of truth for
 *   • which products (CNC / MIS / NRML) are valid for a given
 *     instrument-context (broker + exchange + segment + instrumentType),
 *   • the recommended default product for that same context,
 *   • which order types (MARKET / LIMIT / SL / SL-M) are valid, and
 *   • whether the broker supports market-protection on MARKET orders.
 *
 * Kept as pure functions — no I/O, no Prisma — so the same module can
 * be reused by:
 *   1. `ManualTradeValidatorService` (server-side pre-flight),
 *   2. `ManualTradeService.buildZerodhaOrder` (payload shaping), and
 *   3. eventually mirrored by the admin UI via the extra fields the
 *      validator now surfaces.
 *
 * These rules encode the standard NSE / BSE / MCX / CDS / NFO / BFO
 * product taxonomy — identical across Zerodha, Fyers and Shoonya:
 *
 *   Cash equity (NSE / BSE, EQ)   → CNC (default), MIS
 *   Equity F&O (NFO / BFO)        → NRML (default), MIS
 *   Currency (CDS / BCD)          → NRML (default), MIS
 *   Commodity (MCX)               → NRML (default), MIS
 *
 * If a broker later diverges we can key overrides by `broker` — the
 * function signatures already accept it.
 */

/**
 * Zerodha-only Market-Protection selector for MARKET orders.
 *   AUTO — omit the field (Kite defaults, currently ~1 % for NFO)
 *   P2   — market_protection = 2 %
 *   P5   — market_protection = 5 %
 *   P10  — market_protection = 10 %
 *   NONE — market_protection = 0 (no cap; behaves as pure MARKET)
 */
export type MarketProtectionOption = 'AUTO' | 'P2' | 'P5' | 'P10' | 'NONE';

export const MARKET_PROTECTION_OPTIONS: MarketProtectionOption[] = [
  'AUTO',
  'P2',
  'P5',
  'P10',
  'NONE',
];

export interface InstrumentContext {
  broker: Broker;
  exchange: string;
  segment: string;
  instrumentType: string;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

/**
 * Products that the broker will accept for the given instrument.
 * Empty array means "we don't know" — the caller must treat that
 * conservatively (validator returns a soft-pass rather than a
 * false-positive rejection).
 */
export function getAllowedProducts(ctx: InstrumentContext): ManualTradeProduct[] {
  const cls = classifyInstrument(ctx);
  switch (cls) {
    case 'EQUITY_CASH':
      return ['CNC', 'MIS'];
    case 'EQUITY_FNO':
    case 'CURRENCY':
    case 'COMMODITY':
      return ['NRML', 'MIS'];
    case 'UNKNOWN':
    default:
      // Conservative: allow all — the broker will surface the real
      // rejection at placement time and the ExecutionEventRecorder
      // will classify it. Never reject a trade just because we
      // couldn't infer the segment.
      return ['CNC', 'MIS', 'NRML'];
  }
}

/**
 * Recommended default product for the instrument. Falls back to the
 * first allowed product when the class is unknown.
 */
export function getDefaultProduct(ctx: InstrumentContext): ManualTradeProduct {
  const cls = classifyInstrument(ctx);
  switch (cls) {
    case 'EQUITY_CASH':
      return 'CNC';
    case 'EQUITY_FNO':
    case 'CURRENCY':
    case 'COMMODITY':
      return 'NRML';
    case 'UNKNOWN':
    default:
      return getAllowedProducts(ctx)[0] ?? 'MIS';
  }
}

export function isProductAllowed(
  ctx: InstrumentContext,
  product: ManualTradeProduct,
): boolean {
  const allowed = getAllowedProducts(ctx);
  return allowed.includes(product);
}

// ---------------------------------------------------------------------------
// Order type
// ---------------------------------------------------------------------------

/**
 * Order types the broker will accept for this instrument. All three
 * supported brokers (Zerodha, Fyers, Shoonya) accept the full set on
 * every segment — we still gate it here so future broker-specific
 * carve-outs have a single place to land.
 */
export function getAllowedOrderTypes(
  _ctx: InstrumentContext,
): ManualTradeOrderType[] {
  return ['MARKET', 'LIMIT', 'SL', 'SL-M'];
}

export function isOrderTypeAllowed(
  ctx: InstrumentContext,
  orderType: ManualTradeOrderType,
): boolean {
  return getAllowedOrderTypes(ctx).includes(orderType);
}

// ---------------------------------------------------------------------------
// Market protection
// ---------------------------------------------------------------------------

/** True for brokers whose adapters honour the market-protection field. */
export function supportsMarketProtection(broker: Broker): boolean {
  return broker === Broker.ZERODHA;
}

/**
 * Convert a UI-level Market-Protection selector into the numeric
 * percentage KiteConnect expects on `placeOrder`. `AUTO` returns null
 * so the caller can omit the field entirely (Kite uses its default).
 */
export function marketProtectionPercent(
  option: MarketProtectionOption,
): number | null {
  switch (option) {
    case 'AUTO':
      return null;
    case 'P2':
      return 2;
    case 'P5':
      return 5;
    case 'P10':
      return 10;
    case 'NONE':
      return 0;
    default:
      return null;
  }
}

/**
 * Validate a Market-Protection choice against the current context.
 * Returns null on success, an error string on failure. This is only
 * enforced when the broker supports Market Protection AND the order
 * type is MARKET — every other combination is a no-op.
 */
export function validateMarketProtection(
  ctx: InstrumentContext,
  orderType: ManualTradeOrderType,
  option: MarketProtectionOption | undefined,
): { ok: true } | { ok: false; message: string } {
  if (!supportsMarketProtection(ctx.broker)) {
    if (option !== undefined) {
      return {
        ok: false,
        message: `${ctx.broker} does not support market protection`,
      };
    }
    return { ok: true };
  }
  if (orderType !== 'MARKET') {
    if (option !== undefined) {
      return {
        ok: false,
        message: 'Market protection only applies to MARKET orders',
      };
    }
    return { ok: true };
  }
  // Zerodha + MARKET — option is optional (defaults to AUTO). If
  // present, must be one of the known selectors.
  if (option === undefined) return { ok: true };
  if (!MARKET_PROTECTION_OPTIONS.includes(option)) {
    return {
      ok: false,
      message: `Unknown market protection option "${option}"`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type InstrumentClass =
  | 'EQUITY_CASH'
  | 'EQUITY_FNO'
  | 'CURRENCY'
  | 'COMMODITY'
  | 'UNKNOWN';

/**
 * Classify an instrument using its segment + exchange + type. The
 * inputs are the same strings the Zerodha / Fyers importers persist
 * (schema.prisma :: Instrument.segment / .exchange / .instrumentType).
 */
function classifyInstrument(ctx: InstrumentContext): InstrumentClass {
  const segment = (ctx.segment ?? '').toUpperCase().trim();
  const exchange = (ctx.exchange ?? '').toUpperCase().trim();
  const type = (ctx.instrumentType ?? '').toUpperCase().trim();

  // MCX / commodity — segment or exchange
  if (segment === 'MCX' || exchange === 'MCX' || segment === 'COM') {
    return 'COMMODITY';
  }
  // Currency derivatives
  if (
    segment === 'CDS' ||
    segment === 'BCD' ||
    segment === 'CDS-FUT' ||
    segment === 'CDS-OPT' ||
    exchange === 'CDS' ||
    exchange === 'BCD'
  ) {
    return 'CURRENCY';
  }
  // Equity F&O
  if (
    segment === 'NFO' ||
    segment === 'BFO' ||
    segment === 'NFO-FUT' ||
    segment === 'NFO-OPT' ||
    segment === 'BFO-FUT' ||
    segment === 'BFO-OPT' ||
    exchange === 'NFO' ||
    exchange === 'BFO' ||
    type === 'FUT' ||
    type === 'CE' ||
    type === 'PE'
  ) {
    return 'EQUITY_FNO';
  }
  // Equity cash
  if (
    segment === 'NSE' ||
    segment === 'BSE' ||
    segment === 'NSE-EQ' ||
    segment === 'BSE-EQ' ||
    exchange === 'NSE' ||
    exchange === 'BSE' ||
    type === 'EQ'
  ) {
    return 'EQUITY_CASH';
  }
  return 'UNKNOWN';
}
