/**
 * Follower copy-order translation — the SINGLE place a broker-neutral copy
 * signal is shaped into each broker's native place-order payload for the
 * follower fan-out. Reuses the existing shared order mappers
 * (`buildUpstoxPlaceOrder`, `buildIciciPlaceOrder`) and the exact Fyers /
 * Zerodha order shapes the manual-trade + copy paths already used — nothing is
 * duplicated or re-invented. Copy fan-out places MARKET orders (mirrors the
 * master fill immediately); LIMIT/SL handling stays in the manual/order-action
 * paths that own a price.
 */
import { Broker } from '@prisma/client';

import { buildUpstoxPlaceOrder } from '../order-mapping/upstox-order.mapper';
import { buildIciciPlaceOrder } from '../order-mapping/icici-order.mapper';
import { ResolvedInstrument } from '../order-mapping/instrument-context';

export interface TranslateFollowerOrderParams {
  broker: Broker;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** Follower-broker trading symbol (from InstrumentBroker.brokerSymbol). */
  brokerSymbol: string;
  /** Follower-broker instrument token (Upstox instrument_token); may be null. */
  brokerToken: string | null;
  /** Follower listing exchange (prefers the master's exchange). */
  exchange: string | null;
  /** Resolved instrument facts — drives ICICI product/right/strike/expiry. */
  instrument: ResolvedInstrument | null;
  /**
   * Master trade product (CTS-neutral: CNC / MIS / NRML), forwarded so the
   * follower order mirrors the master's product instead of a hard-coded
   * default. Optional + falls back to the previous per-broker default when
   * absent, so every existing caller stays backward compatible.
   */
  product?: string | null;
}

/**
 * Returns the broker-native order object, or `null` when the broker has no
 * copy-execution translation wired (e.g. SHOONYA) so the caller can record a
 * BROKER_UNSUPPORTED skip without instantiating an adapter.
 */
export function translateFollowerOrder(
  params: TranslateFollowerOrderParams,
): unknown | null {
  switch (params.broker) {
    case Broker.ZERODHA:
      return {
        exchange: params.exchange ?? params.instrument?.exchange ?? '',
        tradingsymbol: params.brokerSymbol,
        transaction_type: params.side,
        quantity: params.quantity,
        product: params.product ?? 'MIS',
        order_type: 'MARKET',
        validity: 'DAY',
      };

    case Broker.FYERS:
      return {
        symbol: params.brokerSymbol,
        qty: params.quantity,
        type: 2, // MARKET
        side: params.side === 'BUY' ? 1 : -1,
        productType: 'INTRADAY',
        limitPrice: 0,
        stopPrice: 0,
        disclosedQty: 0,
        validity: 'DAY',
        offlineOrder: false,
      };

    case Broker.UPSTOX:
      return buildUpstoxPlaceOrder({
        instrumentToken: params.brokerToken ?? params.brokerSymbol,
        side: params.side,
        orderType: 'MARKET',
        quantity: params.quantity,
        product: 'MIS',
        validity: 'DAY',
        tag: 'CTSCopy',
      });

    case Broker.ICICI_DIRECT:
      return buildIciciPlaceOrder({
        stockCode: params.brokerSymbol,
        exchange: params.exchange ?? params.instrument?.exchange ?? '',
        side: params.side,
        orderType: 'MARKET',
        quantity: params.quantity,
        validity: 'DAY',
        instrument: params.instrument ?? null,
        remark: 'CTS Copy',
      });

    default:
      // SHOONYA (and any future broker) has no copy-order translation yet —
      // callers record BROKER_UNSUPPORTED. Unchanged behaviour for Shoonya.
      return null;
  }
}
