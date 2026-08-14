import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { BrokerService } from '../broker.service';
import { ResolvedInstrument } from '../order-mapping/instrument-context';
import {
  ExecutionResultCategory,
  StandardExecutionResult,
  isRetryable,
} from '../../copy-trading/execution-result-category';
import { translateFollowerOrder } from './follower-order-translator';
import {
  normalizeExecutionResponse,
  normalizeExecutionError,
} from './broker-response-normalizer';

export interface FollowerExecutionParams {
  followerAccountId: string;
  broker: Broker;
  side: 'BUY' | 'SELL';
  quantity: number;
  brokerSymbol: string;
  brokerToken: string | null;
  exchange: string | null;
  instrument: ResolvedInstrument | null;
  /** Master trade product (CNC / MIS / NRML) mirrored to the follower order. */
  product?: string | null;
  /** CTS-neutral order type (MARKET / LIMIT / SL / SL-M) mirrored from master. */
  orderType?: string | null;
  /** Limit price for LIMIT / SL (ignored for MARKET / SL-M). */
  price?: number | null;
  /** Trigger price for SL / SL-M. */
  triggerPrice?: number | null;
  /** Source (master) symbol BEFORE translation — observability only. */
  masterSymbol?: string | null;
  followerId?: string | null;
  correlationId?: string | null;
}

/**
 * Best-effort read of the first present alias key from a broker-native order
 * payload. Broker payload shapes differ (Zerodha `order_type`, Fyers `type`,
 * ICICI `exchange_code`, …), so the observability block reads a small alias
 * set and always falls back to the complete JSON below. Returns null when
 * absent so a value of 0 / -1 (e.g. Zerodha market_protection) is preserved.
 */
function pickField(order: unknown, keys: string[]): unknown {
  if (!order || typeof order !== 'object') return null;
  const o = order as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const show = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));

/**
 * Sprint — Zerodha follower execution / dynamic broker execution layer.
 *
 * The SINGLE broker-execution engine for the copy-trading follower fan-out.
 * Resolves the follower's adapter DYNAMICALLY through the existing Broker
 * Factory (`BrokerService.getAdapterForAccount`) — the same credentialed
 * factory the dashboard + master watcher use, which already supports every
 * broker including ZERODHA. There is no hard-coded allow-list and no per-broker
 * switch in CopyTradingService any more.
 *
 * Flow:  BrokerFactory → adapter → order translation → placeOrder →
 *        standardized result (broker-neutral). Adapters are never rewritten;
 *        their raw responses are normalized here so the copy engine only ever
 *        sees a {@link StandardExecutionResult}.
 */
@Injectable()
export class FollowerExecutionService {
  private readonly logger = new Logger(FollowerExecutionService.name);

  constructor(private readonly brokerService: BrokerService) {}

  async place(params: FollowerExecutionParams): Promise<StandardExecutionResult> {
    const base = {
      broker: String(params.broker),
      orderRequest: null as unknown,
      translatedSymbol: params.brokerSymbol ?? null,
      followerAccountId: params.followerAccountId ?? null,
      followerId: params.followerId ?? null,
      correlationId: params.correlationId ?? null,
    };

    // 1) Broker-neutral order translation (reuses the shared mappers).
    const order = translateFollowerOrder({
      broker: params.broker,
      side: params.side,
      quantity: params.quantity,
      brokerSymbol: params.brokerSymbol,
      brokerToken: params.brokerToken,
      exchange: params.exchange,
      instrument: params.instrument,
      product: params.product,
      orderType: params.orderType,
      price: params.price,
      triggerPrice: params.triggerPrice,
    });

    if (order === null) {
      return this.settle(base, {
        success: false,
        category: ExecutionResultCategory.BROKER_UNSUPPORTED,
        retryable: false,
        brokerOrderId: null,
        exchangeOrderId: null,
        httpStatus: null,
        brokerStatus: null,
        brokerMessage: null,
        failureReason: `Broker ${params.broker} has no copy-execution translation`,
        rawResponse: null,
      }, null, null);
    }

    base.orderRequest = order;

    // 2) Resolve the follower adapter DYNAMICALLY via the Broker Factory.
    const resolved = await this.brokerService.getAdapterForAccount(
      params.followerAccountId,
    );

    if (!resolved) {
      return this.settle(base, {
        success: false,
        category: ExecutionResultCategory.NO_BROKER_SESSION,
        retryable: false,
        brokerOrderId: null,
        exchangeOrderId: null,
        httpStatus: null,
        brokerStatus: null,
        brokerMessage: null,
        failureReason: 'No broker session on follower trading account',
        rawResponse: null,
      }, order, null);
    }

    // 3) Place + normalize (raw broker payloads never escape this service).
    //    PERMANENT OBSERVABILITY — log the FINAL payload that will actually be
    //    sent to the broker (ALL brokers), immediately before the API call, and
    //    the normalized broker response immediately after. Never mutates the
    //    order / result and never throws into the execution path.
    this.logFollowerPayload(params, resolved.broker, order);
    const startedAt = Date.now();
    try {
      const raw = await (resolved.adapter as any).placeOrder(order);
      const latencyMs = Date.now() - startedAt;
      const outcome = normalizeExecutionResponse(resolved.broker, raw);
      this.logBrokerResponse(params, resolved.broker, outcome, latencyMs);
      return this.settle(base, outcome, order, latencyMs);
    } catch (err: any) {
      const latencyMs = Date.now() - startedAt;
      this.logger.error(
        `Follower ${params.followerId ?? params.followerAccountId} (${resolved.broker}) placeOrder threw: ${err?.message ?? err}`,
      );
      const outcome = normalizeExecutionError(resolved.broker, err);
      this.logBrokerResponse(params, resolved.broker, outcome, latencyMs);
      return this.settle(base, outcome, order, latencyMs);
    }
  }

  /**
   * PERMANENT OBSERVABILITY — the FINAL broker payload, logged for EVERY broker
   * right before the placeOrder API call. Named fields are best-effort across
   * broker payload shapes; the complete JSON is always printed so nothing is
   * ever lost. Additive only — does not influence execution.
   */
  private logFollowerPayload(
    params: FollowerExecutionParams,
    broker: Broker,
    order: unknown,
  ): void {
    const p = (keys: string[]) => pickField(order, keys);
    const block = [
      '---------------------------------------------',
      'FOLLOWER EXECUTION PAYLOAD',
      '---------------------------------------------',
      `Correlation ID         : ${show(params.correlationId)}`,
      `Follower Account       : ${show(params.followerAccountId)}`,
      `Broker                 : ${show(broker)}`,
      `Exchange               : ${show(p(['exchange', 'exchange_code']) ?? params.exchange)}`,
      `Original Master Symbol : ${show(params.masterSymbol)}`,
      `Translated Symbol      : ${show(params.brokerSymbol ?? p(['tradingsymbol', 'symbol', 'stock_code', 'instrument_token']))}`,
      `Quantity               : ${show(p(['quantity', 'qty']) ?? params.quantity)}`,
      `Side                   : ${show(p(['transaction_type', 'action', 'side']) ?? params.side)}`,
      `Order Type             : ${show(p(['order_type', 'type']))}`,
      `Product                : ${show(p(['product', 'productType']))}`,
      `Variety                : ${show(p(['variety']))}`,
      `Price                  : ${show(p(['price', 'limitPrice']))}`,
      `Trigger Price          : ${show(p(['trigger_price', 'stopPrice', 'stoploss']))}`,
      `Market Protection      : ${show(p(['market_protection']))}`,
      `Tag                    : ${show(p(['tag', 'user_remark', 'remark']))}`,
      `Autoslice              : ${show(p(['slice', 'autoslice', 'auto_slice']))}`,
      `Complete JSON payload  : ${safeJson(order)}`,
      '---------------------------------------------',
    ].join('\n');
    this.logger.log('\n' + block);
  }

  /**
   * PERMANENT OBSERVABILITY — the normalized broker response, logged for EVERY
   * broker right after placeOrder settles (success OR failure). Reads the
   * broker-neutral outcome so the raw broker response is always captured.
   */
  private logBrokerResponse(
    params: FollowerExecutionParams,
    broker: Broker,
    outcome: {
      success: boolean;
      category: ExecutionResultCategory;
      retryable: boolean;
      brokerOrderId: string | null;
      exchangeOrderId: string | null;
      httpStatus: number | null;
      brokerStatus: string | null;
      brokerMessage: string | null;
      failureReason: string | null;
      rawResponse: unknown | null;
    },
    latencyMs: number | null,
  ): void {
    const block = [
      '---------------------------------------------',
      'BROKER RESPONSE',
      '---------------------------------------------',
      `Correlation ID             : ${show(params.correlationId)}`,
      `Follower Account           : ${show(params.followerAccountId)}`,
      `Broker                     : ${show(broker)}`,
      `HTTP Status                : ${show(outcome.httpStatus)}`,
      `Broker Status              : ${show(outcome.brokerStatus)}`,
      `Order ID                   : ${show(outcome.brokerOrderId)}`,
      `Exchange Order ID          : ${show(outcome.exchangeOrderId)}`,
      `Broker Message             : ${show(outcome.brokerMessage ?? outcome.failureReason)}`,
      `Normalized Result Category : ${show(outcome.category)}`,
      `Retryable                  : ${show(outcome.retryable ?? isRetryable(outcome.category))}`,
      `Latency                    : ${latencyMs != null ? `${latencyMs}ms` : '-'}`,
      `Raw broker response        : ${safeJson(outcome.rawResponse)}`,
      '---------------------------------------------',
    ].join('\n');
    this.logger.log('\n' + block);
  }

  private settle(
    base: {
      broker: string;
      orderRequest: unknown;
      translatedSymbol: string | null;
      followerAccountId: string | null;
      followerId: string | null;
      correlationId: string | null;
    },
    outcome: {
      success: boolean;
      category: ExecutionResultCategory;
      retryable: boolean;
      brokerOrderId: string | null;
      exchangeOrderId: string | null;
      httpStatus: number | null;
      brokerStatus: string | null;
      brokerMessage: string | null;
      failureReason: string | null;
      rawResponse: unknown | null;
    },
    order: unknown,
    latencyMs: number | null,
  ): StandardExecutionResult {
    return {
      broker: base.broker,
      success: outcome.success,
      category: outcome.category,
      retryable: outcome.retryable ?? isRetryable(outcome.category),
      brokerOrderId: outcome.brokerOrderId,
      exchangeOrderId: outcome.exchangeOrderId,
      httpStatus: outcome.httpStatus,
      brokerStatus: outcome.brokerStatus,
      brokerMessage: outcome.brokerMessage,
      failureReason: outcome.failureReason,
      latencyMs,
      executionTime: new Date().toISOString(),
      orderRequest: order ?? base.orderRequest,
      translatedSymbol: base.translatedSymbol,
      followerAccountId: base.followerAccountId,
      followerId: base.followerId,
      correlationId: base.correlationId,
      rawResponse: outcome.rawResponse,
    };
  }
}
