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
  followerId?: string | null;
  correlationId?: string | null;
}

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
    const startedAt = Date.now();
    try {
      const raw = await (resolved.adapter as any).placeOrder(order);
      const latencyMs = Date.now() - startedAt;
      const outcome = normalizeExecutionResponse(resolved.broker, raw);
      return this.settle(base, outcome, order, latencyMs);
    } catch (err: any) {
      const latencyMs = Date.now() - startedAt;
      this.logger.error(
        `Follower ${params.followerId ?? params.followerAccountId} (${resolved.broker}) placeOrder threw: ${err?.message ?? err}`,
      );
      const outcome = normalizeExecutionError(resolved.broker, err);
      return this.settle(base, outcome, order, latencyMs);
    }
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
