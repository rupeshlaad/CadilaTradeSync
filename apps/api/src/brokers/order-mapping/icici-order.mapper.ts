/**
 * Sprint 6.2.8 — ICICI Direct (Breeze) `place_order` payload mapper.
 *
 * SINGLE source of the Breeze order payload. Previously three services
 * (`ManualTradeService`, `OrderActionsService`, follower fan-out) each shaped
 * their own ICICI payload inline, which is exactly how the production bug
 * ("product: margin" + "user_remark: CTS Manual Trade") survived: fixing one
 * copy left the others wrong. This is now the ONLY producer of a Breeze order
 * body. Zerodha / Fyers keep their existing (working) builders untouched.
 *
 * Compliance is checked against the official Breeze API `place_order`
 * reference + the Breeze-Python-SDK:
 *   stock_code, exchange_code (UPPER), product (cash/futures/options),
 *   action (buy/sell), order_type (limit/market/stoploss), quantity,
 *   price ("" for market), stoploss (trigger), validity (day/ioc),
 *   validity_date (""), disclosed_quantity ("0"), expiry_date (ISO,
 *   derivatives only), right (call/put/others), strike_price (options),
 *   user_remark (alphanumeric only).
 *
 * Root-cause notes:
 *   • product is INSTRUMENT-AWARE. Breeze rejects `margin` for NSE/BSE cash
 *     without a margin entitlement ("Product-type should be either 'cash',
 *     'eatm' …"). Equity cash therefore ALWAYS resolves to `cash` regardless
 *     of the CTS CNC/MIS/NRML tag; futures → `futures`; options → `options`.
 *   • SL-M has no native Breeze equivalent — it is emulated as a marketable
 *     stoploss (order_type=stoploss, price = trigger) so it fills like a
 *     market order once the trigger is hit.
 */
import {
  ResolvedInstrument,
  classifyResolvedInstrument,
} from './instrument-context';
import { sanitizeUserRemark } from './user-remark';

export type IciciSide = 'BUY' | 'SELL';
export type CtsOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

export type IciciProduct = 'cash' | 'futures' | 'options';
export type IciciBreezeOrderType = 'market' | 'limit' | 'stoploss';
export type IciciRight = 'call' | 'put' | 'others' | '';

export interface BuildIciciOrderParams {
  /** Breeze `stock_code` — the ICICI broker symbol for this instrument. */
  stockCode: string;
  /** Exchange code; uppercased in the payload. */
  exchange: string;
  side: IciciSide;
  orderType: CtsOrderType;
  quantity: number;
  price?: number | null;
  triggerPrice?: number | null;
  /** DAY / IOC (case-insensitive); defaults to DAY. */
  validity?: string | null;
  /** Resolved instrument facts — drives product / right / strike / expiry. */
  instrument?: ResolvedInstrument | null;
  /** Free-text remark; sanitized to alphanumeric before it hits Breeze. */
  remark?: string | null;
}

export interface IciciOrderPayload {
  stock_code: string;
  exchange_code: string;
  product: IciciProduct;
  action: 'buy' | 'sell';
  order_type: IciciBreezeOrderType;
  quantity: string;
  price: string;
  stoploss: string;
  validity: string;
  validity_date: string;
  disclosed_quantity: string;
  expiry_date: string;
  right: IciciRight;
  strike_price: string;
  user_remark: string;
}

/**
 * Breeze `product` for an instrument. Equity cash is always `cash` (Breeze
 * rejects `margin` on cash without entitlement — the reported production
 * failure); derivatives resolve to `futures` / `options`.
 */
export function resolveIciciProduct(
  instrument?: ResolvedInstrument | null,
): IciciProduct {
  switch (classifyResolvedInstrument(instrument)) {
    case 'OPTION':
      return 'options';
    case 'FUTURE':
      return 'futures';
    case 'EQUITY_CASH':
    default:
      return 'cash';
  }
}

/** Breeze `right`: call/put for options, others for futures, "" for cash. */
export function resolveIciciRight(
  instrument?: ResolvedInstrument | null,
): IciciRight {
  const opt = (instrument?.optionType ?? '').toUpperCase().trim();
  if (opt === 'CE') return 'call';
  if (opt === 'PE') return 'put';
  return resolveIciciProduct(instrument) === 'futures' ? 'others' : '';
}

export function mapIciciOrderType(orderType: CtsOrderType): IciciBreezeOrderType {
  switch (orderType) {
    case 'LIMIT':
      return 'limit';
    case 'SL':
    case 'SL-M':
      return 'stoploss';
    case 'MARKET':
    default:
      return 'market';
  }
}

export function buildIciciPlaceOrder(
  params: BuildIciciOrderParams,
): IciciOrderPayload {
  const product = resolveIciciProduct(params.instrument);
  const orderType = mapIciciOrderType(params.orderType);

  const isMarket = params.orderType === 'MARKET';
  const isSlm = params.orderType === 'SL-M';
  const wantsLimitPrice = params.orderType === 'LIMIT' || params.orderType === 'SL';
  const wantsTrigger = params.orderType === 'SL' || params.orderType === 'SL-M';

  // MARKET → no price. LIMIT / SL → the limit price. SL-M has no native Breeze
  // market-stop, so it is emulated as a marketable stoploss (price = trigger).
  let price = '';
  if (wantsLimitPrice && params.price !== undefined && params.price !== null) {
    price = String(params.price);
  } else if (isSlm && params.triggerPrice !== undefined && params.triggerPrice !== null) {
    price = String(params.triggerPrice);
  }

  const stoploss =
    wantsTrigger && params.triggerPrice !== undefined && params.triggerPrice !== null
      ? String(params.triggerPrice)
      : '';

  const isOption = product === 'options';
  const isDerivative = product === 'options' || product === 'futures';

  return {
    stock_code: params.stockCode,
    exchange_code: (params.exchange ?? '').toUpperCase(),
    product,
    action: params.side === 'BUY' ? 'buy' : 'sell',
    order_type: orderType,
    quantity: String(params.quantity),
    price: isMarket ? '' : price,
    stoploss,
    validity: (params.validity ?? 'DAY').toLowerCase(),
    validity_date: '',
    disclosed_quantity: '0',
    expiry_date:
      isDerivative && params.instrument?.expiry ? params.instrument.expiry : '',
    right: resolveIciciRight(params.instrument),
    strike_price:
      isOption && params.instrument?.strike !== null && params.instrument?.strike !== undefined
        ? String(params.instrument.strike)
        : '',
    user_remark: sanitizeUserRemark(params.remark),
  };
}
