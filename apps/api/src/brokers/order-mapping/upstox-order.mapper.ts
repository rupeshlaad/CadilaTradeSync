/**
 * Sprint 6.3 — Upstox (Uplink v2) `/order/place` payload mapper.
 *
 * SINGLE source of the Upstox order payload (mirrors the ICICI mapper
 * discipline). Every producer of an Upstox order — manual trade, order
 * actions (exit), copy-trading follower fan-out — builds the Breeze-style
 * payload through THIS function so a field/product bug can never regress in
 * one caller while the others stay correct.
 *
 * Upstox order body (official v2 place-order reference):
 *   instrument_token   the Upstox instrument key (e.g. "NSE_EQ|INE002A01018")
 *   quantity           integer (units, NOT lots for equity)
 *   product            "I" (intraday/MIS) | "D" (delivery/CNC & carryforward/NRML)
 *   validity           "DAY" | "IOC"
 *   price              limit price (0 for MARKET / SL-M)
 *   trigger_price      trigger for SL / SL-M (0 otherwise)
 *   order_type         "MARKET" | "LIMIT" | "SL" | "SL-M"
 *   transaction_type   "BUY" | "SELL"
 *   disclosed_quantity integer (0 default)
 *   is_amo             boolean (false — regular order)
 *   tag                short free-text client tag
 */

export type UpstoxSide = 'BUY' | 'SELL';
export type CtsOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type CtsProduct = 'CNC' | 'MIS' | 'NRML';
export type UpstoxProduct = 'I' | 'D';
export type UpstoxOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

export interface BuildUpstoxOrderParams {
  /** Upstox `instrument_token` (instrument key). */
  instrumentToken: string;
  side: UpstoxSide;
  orderType: CtsOrderType;
  quantity: number;
  product?: CtsProduct | null;
  price?: number | null;
  triggerPrice?: number | null;
  /** DAY / IOC (case-insensitive); defaults to DAY. */
  validity?: string | null;
  /** Short client tag (Upstox caps tags; kept alphanumeric + short). */
  tag?: string | null;
}

export interface UpstoxOrderPayload {
  instrument_token: string;
  quantity: number;
  product: UpstoxProduct;
  validity: string;
  price: number;
  trigger_price: number;
  order_type: UpstoxOrderType;
  transaction_type: 'BUY' | 'SELL';
  disclosed_quantity: number;
  is_amo: boolean;
  // V3 order API fields (api-hft.upstox.com/v3/order/place).
  slice: boolean;
  tag: string;
}

/** MIS → intraday ("I"); CNC & NRML → delivery/carryforward ("D"). */
export function resolveUpstoxProduct(product?: CtsProduct | null): UpstoxProduct {
  return product === 'MIS' ? 'I' : 'D';
}

/** CTS order type → Upstox order type (identical vocabulary). */
export function mapUpstoxOrderType(orderType: CtsOrderType): UpstoxOrderType {
  switch (orderType) {
    case 'LIMIT':
      return 'LIMIT';
    case 'SL':
      return 'SL';
    case 'SL-M':
      return 'SL-M';
    case 'MARKET':
    default:
      return 'MARKET';
  }
}

/** Upstox tags: keep short + alphanumeric (a stray literal would be rejected). */
export function sanitizeUpstoxTag(input?: string | null): string {
  const cleaned = String(input ?? '').replace(/[^A-Za-z0-9]/g, '');
  return (cleaned.length > 0 ? cleaned : 'CTSTrade').slice(0, 20);
}

export function buildUpstoxPlaceOrder(
  params: BuildUpstoxOrderParams,
): UpstoxOrderPayload {
  const orderType = mapUpstoxOrderType(params.orderType);
  const wantsLimitPrice = params.orderType === 'LIMIT' || params.orderType === 'SL';
  const wantsTrigger = params.orderType === 'SL' || params.orderType === 'SL-M';

  const price =
    wantsLimitPrice && params.price !== undefined && params.price !== null
      ? Number(params.price)
      : 0;
  const triggerPrice =
    wantsTrigger && params.triggerPrice !== undefined && params.triggerPrice !== null
      ? Number(params.triggerPrice)
      : 0;

  return {
    instrument_token: params.instrumentToken,
    quantity: Math.trunc(params.quantity),
    product: resolveUpstoxProduct(params.product),
    validity: (params.validity ?? 'DAY').toUpperCase() === 'IOC' ? 'IOC' : 'DAY',
    price,
    trigger_price: triggerPrice,
    order_type: orderType,
    transaction_type: params.side,
    disclosed_quantity: 0,
    is_amo: false,
    slice: false,
    tag: sanitizeUpstoxTag(params.tag),
  };
}
