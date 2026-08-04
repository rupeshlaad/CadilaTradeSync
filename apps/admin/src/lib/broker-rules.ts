/**
 * Sprint 5.4.2 — Admin-side mirror of `apps/api/src/manual-trading/broker-rules.ts`.
 *
 * Kept intentionally minimal and PURE so the Manual Trading form can:
 *   • auto-select a sensible default Product on instrument selection,
 *   • filter the Product & Order Type dropdowns to broker-allowed
 *     values,
 *   • show the Market-Protection control only when the broker
 *     supports it and the order type is MARKET,
 *   • flag broker-rejected combinations before the user clicks
 *     Place Order (avoiding an unnecessary round-trip).
 *
 * The rules encoded here MUST stay in lockstep with the server's
 * `broker-rules.ts` — the server is authoritative and will re-run
 * every check on submit. Any drift will surface as a rejected
 * pre-flight in the Validation Summary rather than a silent bug.
 */

import type { Broker } from '@cts/shared';
import type {
  ManualInstrumentSearchRow,
  ManualTradeMarketProtection,
  ManualTradeOrderType,
  ManualTradeProduct,
} from './api';

export const MARKET_PROTECTION_OPTIONS: {
  value: ManualTradeMarketProtection;
  label: string;
}[] = [
  { value: 'AUTO', label: 'Auto (broker default)' },
  { value: 'P2', label: '2%' },
  { value: 'P5', label: '5%' },
  { value: 'P10', label: '10%' },
  { value: 'NONE', label: 'None (0%)' },
];

export interface InstrumentContext {
  broker: Broker;
  exchange: string;
  segment: string;
  instrumentType: string;
}

export function toInstrumentContext(
  broker: Broker,
  row: ManualInstrumentSearchRow,
): InstrumentContext {
  // The picker doesn't ship `instrumentType` today, but the row's
  // optionType / strike / expiry combination tells us everything we
  // need to classify the instrument correctly.
  const inferredType = row.optionType
    ? row.optionType
    : row.expiry
    ? 'FUT'
    : 'EQ';
  return {
    broker,
    exchange: row.exchange,
    segment: row.segment,
    instrumentType: inferredType,
  };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export function getAllowedProducts(
  ctx: InstrumentContext,
): ManualTradeProduct[] {
  switch (classifyInstrument(ctx)) {
    case 'EQUITY_CASH':
      return ['CNC', 'MIS'];
    case 'EQUITY_FNO':
    case 'CURRENCY':
    case 'COMMODITY':
      return ['NRML', 'MIS'];
    default:
      return ['CNC', 'MIS', 'NRML'];
  }
}

export function getDefaultProduct(ctx: InstrumentContext): ManualTradeProduct {
  switch (classifyInstrument(ctx)) {
    case 'EQUITY_CASH':
      return 'CNC';
    case 'EQUITY_FNO':
    case 'CURRENCY':
    case 'COMMODITY':
      return 'NRML';
    default:
      return getAllowedProducts(ctx)[0] ?? 'MIS';
  }
}

export function isProductAllowed(
  ctx: InstrumentContext,
  product: ManualTradeProduct,
): boolean {
  return getAllowedProducts(ctx).includes(product);
}

// ---------------------------------------------------------------------------
// Order type
// ---------------------------------------------------------------------------

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

export function supportsMarketProtection(broker: Broker | null): boolean {
  return broker === 'ZERODHA';
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

type InstrumentClass =
  | 'EQUITY_CASH'
  | 'EQUITY_FNO'
  | 'CURRENCY'
  | 'COMMODITY'
  | 'UNKNOWN';

function classifyInstrument(ctx: InstrumentContext): InstrumentClass {
  const segment = (ctx.segment ?? '').toUpperCase().trim();
  const exchange = (ctx.exchange ?? '').toUpperCase().trim();
  const type = (ctx.instrumentType ?? '').toUpperCase().trim();

  if (segment === 'MCX' || exchange === 'MCX' || segment === 'COM') {
    return 'COMMODITY';
  }
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
