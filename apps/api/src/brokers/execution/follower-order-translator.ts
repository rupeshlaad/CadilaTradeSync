/**
 * Follower copy-order translation — the SINGLE place a broker-neutral copy
 * signal is shaped into each broker's native place-order payload for the
 * follower fan-out. Reuses the existing shared order mappers
 * (`buildUpstoxPlaceOrder`, `buildIciciPlaceOrder`, `buildFyersPlaceOrder`) and
 * the exact Zerodha order shape the manual-trade + copy paths already used —
 * nothing is duplicated or re-invented.
 *
 * The master's CTS-neutral orderType / price / triggerPrice are now propagated
 * (previously hard-coded to MARKET / 0). The ACTUAL broker-specific order-type
 * mapping stays inside each broker's own layer:
 *   - Zerodha: Kite's vocabulary == CTS (MARKET/LIMIT/SL/SL-M) → identity.
 *   - Fyers:   brokers/fyers/fyers-order.mapper (numeric type code).
 *   - Upstox:  brokers/order-mapping/upstox-order.mapper.
 *   - ICICI:   brokers/order-mapping/icici-order.mapper.
 *   - Shoonya: ShoonyaAdapter.placeOrder (prctyp/prc/trgprc).
 * When orderType is absent the previous MARKET behaviour is preserved exactly.
 */
import { Broker } from '@prisma/client';

import { buildUpstoxPlaceOrder } from '../order-mapping/upstox-order.mapper';
import { buildIciciPlaceOrder } from '../order-mapping/icici-order.mapper';
import { buildFyersPlaceOrder } from '../fyers/fyers-order.mapper';
import { ResolvedInstrument } from '../order-mapping/instrument-context';

type CtsOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

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
  /**
   * Master CTS-neutral order type (MARKET / LIMIT / SL / SL-M). Optional;
   * defaults to MARKET when absent (previous behaviour).
   */
  orderType?: string | null;
  /** Limit price for LIMIT / SL (ignored for MARKET / SL-M). */
  price?: number | null;
  /** Trigger price for SL / SL-M. */
  triggerPrice?: number | null;
}

/** Coerce any incoming order-type string to the CTS-neutral union (default MARKET). */
function ctsOrderType(value: string | null | undefined): CtsOrderType {
  const v = String(value ?? '').trim().toUpperCase();
  if (v === 'LIMIT' || v === 'SL' || v === 'SL-M') return v;
  return 'MARKET';
}

/**
 * Returns the broker-native order object, or `null` when the broker has no
 * copy-execution translation wired so the caller can record a
 * BROKER_UNSUPPORTED skip without instantiating an adapter.
 */
export function translateFollowerOrder(
  params: TranslateFollowerOrderParams,
): unknown | null {
  const orderType = ctsOrderType(params.orderType);
  const price = params.price ?? 0;
  const triggerPrice = params.triggerPrice ?? null;
  const wantsLimitPrice = orderType === 'LIMIT' || orderType === 'SL';
  const wantsTrigger = orderType === 'SL' || orderType === 'SL-M';

  switch (params.broker) {
    case Broker.ZERODHA: {
      // Kite order_type vocabulary is identical to CTS — pass through. Price /
      // trigger_price are attached ONLY when the order type needs them so a
      // MARKET copy payload is byte-identical to the previous behaviour.
      const zerodha: Record<string, any> = {
        exchange: params.exchange ?? params.instrument?.exchange ?? '',
        tradingsymbol: params.brokerSymbol,
        transaction_type: params.side,
        quantity: params.quantity,
        product: params.product ?? 'MIS',
        order_type: orderType,
        validity: 'DAY',
      };
      if (wantsLimitPrice) zerodha.price = price;
      if (wantsTrigger) zerodha.trigger_price = triggerPrice ?? 0;
      return zerodha;
    }

    case Broker.FYERS:
      return buildFyersPlaceOrder({
        symbol: params.brokerSymbol,
        side: params.side,
        quantity: params.quantity,
        orderType,
        price,
        triggerPrice,
        productType: 'INTRADAY',
        validity: 'DAY',
      });

    case Broker.UPSTOX:
      return buildUpstoxPlaceOrder({
        instrumentToken: params.brokerToken ?? params.brokerSymbol,
        side: params.side,
        orderType,
        quantity: params.quantity,
        product: 'MIS',
        validity: 'DAY',
        tag: 'CTSCopy',
        price,
        triggerPrice,
      });

    case Broker.ICICI_DIRECT:
      return buildIciciPlaceOrder({
        stockCode: params.brokerSymbol,
        exchange: params.exchange ?? params.instrument?.exchange ?? '',
        side: params.side,
        orderType,
        quantity: params.quantity,
        validity: 'DAY',
        instrument: params.instrument ?? null,
        remark: 'CTS Copy',
        price,
        triggerPrice,
      });

    case Broker.SHOONYA:
      // Broker-NEUTRAL intermediate only. All Shoonya/Noren-specific encoding
      // (product → prd C/I/M, side → trantype B/S, orderType → prctyp
      // MKT/LMT/SL-*, price → prc, triggerPrice → trgprc) lives INSIDE
      // ShoonyaAdapter.placeOrder, so no broker-specific logic leaks here.
      return {
        exchange: params.exchange ?? params.instrument?.exchange ?? 'NSE',
        tradingSymbol: params.brokerSymbol,
        side: params.side,
        quantity: params.quantity,
        product: params.product ?? 'MIS',
        orderType,
        price,
        triggerPrice,
        validity: 'DAY',
      };

    default:
      // Any future broker with no copy-execution translation yet — callers
      // record BROKER_UNSUPPORTED.
      return null;
  }
}
