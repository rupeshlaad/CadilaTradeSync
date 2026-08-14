/**
 * Fyers order mapper — the SINGLE place that maps a CTS-neutral order type
 * onto Fyers-native fields. Mirrors the Upstox / ICICI order-mapping modules
 * so broker-specific order-type mapping lives inside the broker's own layer
 * (never in CopyTradingService / FollowerExecutionService).
 *
 * Fyers `type` codes (fyers-api-v3):
 *   1 = LIMIT · 2 = MARKET · 3 = SL-M (stop market) · 4 = SL (stop limit)
 */

export type CtsOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

export interface BuildFyersOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: CtsOrderType;
  price?: number | null;
  triggerPrice?: number | null;
  productType?: string;
  validity?: string;
}

export interface FyersOrderPayload {
  symbol: string;
  qty: number;
  type: number;
  side: number;
  productType: string;
  limitPrice: number;
  stopPrice: number;
  disclosedQty: number;
  validity: string;
  offlineOrder: boolean;
}

/** CTS order type → Fyers numeric type code. */
export function mapFyersOrderTypeCode(orderType: CtsOrderType): number {
  switch (orderType) {
    case 'LIMIT':
      return 1;
    case 'SL-M':
      return 3;
    case 'SL':
      return 4;
    case 'MARKET':
    default:
      return 2;
  }
}

export function buildFyersPlaceOrder(
  params: BuildFyersOrderParams,
): FyersOrderPayload {
  const type = mapFyersOrderTypeCode(params.orderType);
  const wantsLimitPrice = params.orderType === 'LIMIT' || params.orderType === 'SL';
  const wantsTrigger = params.orderType === 'SL' || params.orderType === 'SL-M';

  const limitPrice =
    wantsLimitPrice && params.price !== undefined && params.price !== null
      ? Number(params.price)
      : 0;
  const stopPrice =
    wantsTrigger && params.triggerPrice !== undefined && params.triggerPrice !== null
      ? Number(params.triggerPrice)
      : 0;

  return {
    symbol: params.symbol,
    qty: params.quantity,
    type,
    side: params.side === 'BUY' ? 1 : -1,
    productType: params.productType ?? 'INTRADAY',
    limitPrice,
    stopPrice,
    disclosedQty: 0,
    validity: params.validity ?? 'DAY',
    offlineOrder: false,
  };
}
