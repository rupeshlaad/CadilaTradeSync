import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from '../brokers/zerodha/zerodha.adapter';
import { FyersAdapter } from '../brokers/fyers/fyers.adapter';
import { ICICIDirectAdapter } from '../brokers/icici/icici.adapter';
import { UpstoxAdapter } from '../brokers/upstox/upstox.adapter';
import { InstrumentResolverService } from '../instruments/instrument-resolver.service';
import { buildIciciPlaceOrder } from '../brokers/order-mapping/icici-order.mapper';
import {
  buildUpstoxPlaceOrder,
  mapUpstoxOrderType,
  CtsOrderType,
} from '../brokers/order-mapping/upstox-order.mapper';
import { ResolvedInstrument } from '../brokers/order-mapping/instrument-context';

import { PositionLifecycleService } from '../position-lifecycle/position-lifecycle.service';
import { PositionRegistryService } from '../position-lifecycle/position-registry.service';
import {
  LifecycleEvent,
  LifecycleEventType,
  PositionRecord,
} from '../position-lifecycle/lifecycle.types';

import {
  assertCancelAllowed,
  assertExitAllowed,
  assertModifyAllowed,
  validateBrokerModifyPayload,
} from './order-action-rules';
import {
  CancelOrderDto,
  ExitOrderDto,
  ModifyOrderDto,
} from './order-actions.dto';
import { OrderActionResult, OrderActionType } from './order-actions.types';

/**
 * Sprint 5.5.1 — Order Actions orchestrator (Modify / Cancel / Exit).
 *
 * The Master Order is the single source of truth. Every admin-initiated
 * action:
 *
 *   1. Resolves the tracked master position from the PositionRegistry.
 *   2. Validates the action against state-machine + broker rules
 *      (see `order-action-rules.ts`).
 *   3. Calls the corresponding operation on the master broker via the
 *      existing adapter (`ZerodhaAdapter` / `FyersAdapter`) — NO
 *      duplicated broker logic; only argument shaping.
 *   4. Builds a canonical `LifecycleEvent` and hands it to
 *      `PositionLifecycleService.ingestAdminEvent()` so the SAME
 *      state-machine + `PositionSynchronizationService` fan-out (and
 *      therefore the `ExecutionEventRecorderService.onCommit` →
 *      `ExecutionHistoryService.persist` audit chain) runs exactly
 *      as it does for broker-detected transitions.
 *
 * Followers are never mutated directly by this service. Their MODIFY
 * / CANCEL / EXIT are dispatched by `PositionSynchronizationService`
 * as a side-effect of ingesting the master lifecycle event.
 */
@Injectable()
export class OrderActionsService {
  private readonly logger = new Logger(OrderActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly registry: PositionRegistryService,
    private readonly lifecycle: PositionLifecycleService,
    private readonly resolver: InstrumentResolverService,
  ) {}

  // -------------------------------------------------------------------------
  // Public actions
  // -------------------------------------------------------------------------

  async modify(key: string, dto: ModifyOrderDto): Promise<OrderActionResult> {
    const position = this.resolvePosition(key);
    assertModifyAllowed(position);

    const patch = {
      quantity: dto.quantity ?? position.quantity,
      price: dto.price ?? position.price,
      triggerPrice: dto.triggerPrice ?? position.triggerPrice,
      orderType: dto.orderType ?? position.orderType,
    };
    validateBrokerModifyPayload(position.broker, patch);

    const brokerResponse = await this.callMasterModify(position, patch);

    const event = this.buildEvent(position, LifecycleEventType.ORDER_MODIFY, {
      quantity: patch.quantity,
      price: patch.price,
      triggerPrice: patch.triggerPrice,
      orderType: patch.orderType,
      rawStatus: 'MODIFIED',
      brokerResponse,
    });

    return this.applyAndFinalize(
      'MODIFY',
      key,
      event,
      'ADMIN_MODIFY',
      brokerResponse,
    );
  }

  async cancel(key: string, dto: CancelOrderDto): Promise<OrderActionResult> {
    const position = this.resolvePosition(key);
    assertCancelAllowed(position);

    const brokerResponse = await this.callMasterCancel(position);

    const event = this.buildEvent(position, LifecycleEventType.CANCEL, {
      quantity: position.quantity,
      price: position.price,
      triggerPrice: position.triggerPrice,
      orderType: position.orderType,
      rawStatus: 'CANCELLED',
      reason: dto?.reason ?? null,
      brokerResponse,
    });

    return this.applyAndFinalize(
      'CANCEL',
      key,
      event,
      'ADMIN_CANCEL',
      brokerResponse,
    );
  }

  async exit(key: string, dto: ExitOrderDto): Promise<OrderActionResult> {
    const position = this.resolvePosition(key);
    assertExitAllowed(position);

    // Exit the currently-open filled quantity. Fall back to the full
    // order quantity if the broker has not yet reported a filled qty
    // (should not happen once EXIT_STATES is enforced, but be safe).
    const exitQuantity =
      position.filledQuantity > 0 ? position.filledQuantity : position.quantity;

    const brokerResponse = await this.callMasterExit(position, exitQuantity);

    const event = this.buildEvent(position, LifecycleEventType.EXIT, {
      quantity: exitQuantity,
      // MARKET reverse — no explicit price / trigger.
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      rawStatus: 'EXIT',
      reason: dto?.reason ?? null,
      brokerResponse,
    });

    return this.applyAndFinalize(
      'EXIT',
      key,
      event,
      'ADMIN_EXIT',
      brokerResponse,
    );
  }

  // -------------------------------------------------------------------------
  // Position resolution
  // -------------------------------------------------------------------------

  /**
   * Accept either the registry key (`{broker}:{accountId}:{orderId}`)
   * or a bare broker order id — the same fallback the read-only
   * PositionLifecycleController uses.
   */
  private resolvePosition(key: string): PositionRecord {
    let record = this.registry.get(key);
    if (!record) {
      record =
        this.registry.list().find((p) => p.brokerOrderId === key) ?? null;
    }
    if (!record) {
      throw new NotFoundException(`Position ${key} not tracked`);
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // Master broker calls (existing adapters, no duplicated broker logic)
  // -------------------------------------------------------------------------

  private async callMasterModify(
    position: PositionRecord,
    patch: {
      quantity: number;
      price: number | null;
      triggerPrice: number | null;
      orderType: string | null;
    },
  ): Promise<unknown> {
    const accessToken = await this.loadAccessToken(position);
    const orderType = (patch.orderType ?? '').toUpperCase();

    if (position.broker === Broker.ZERODHA) {
      const adapter = new ZerodhaAdapter();
      adapter.setAccessToken(accessToken);

      const payload: Record<string, unknown> = { quantity: patch.quantity };
      if (patch.orderType) payload.order_type = orderType;
      if (
        patch.price !== null &&
        (orderType === 'LIMIT' || orderType === 'SL')
      ) {
        payload.price = patch.price;
      }
      if (
        patch.triggerPrice !== null &&
        (orderType === 'SL' || orderType === 'SL-M')
      ) {
        payload.trigger_price = patch.triggerPrice;
      }
      return adapter.modifyOrder(position.brokerOrderId, payload);
    }

    if (position.broker === Broker.FYERS) {
      const adapter = new FyersAdapter();
      adapter.setAccessToken(accessToken);

      const payload: Record<string, unknown> = {
        id: position.brokerOrderId,
        qty: patch.quantity,
        type: mapFyersOrderTypeCode(patch.orderType),
        limitPrice: patch.price ?? 0,
        stopPrice: patch.triggerPrice ?? 0,
      };
      return adapter.modifyOrder(position.brokerOrderId, payload);
    }

    if (position.broker === Broker.ICICI_DIRECT) {
      const adapter = await this.buildIciciAdapter(position, accessToken);
      const payload: Record<string, unknown> = {
        exchange_code: position.exchange ?? 'NSE',
        quantity: String(patch.quantity),
      };
      if (patch.orderType) payload.order_type = mapIciciOrderType(orderType);
      if (patch.price !== null && (orderType === 'LIMIT' || orderType === 'SL')) {
        payload.price = String(patch.price);
      }
      if (
        patch.triggerPrice !== null &&
        (orderType === 'SL' || orderType === 'SL-M')
      ) {
        payload.stoploss = String(patch.triggerPrice);
      }
      return adapter.modifyOrder(position.brokerOrderId, payload);
    }

    if (position.broker === Broker.UPSTOX) {
      const adapter = await this.buildUpstoxAdapter(position, accessToken);
      const payload: Record<string, unknown> = {
        quantity: patch.quantity,
        order_type: mapUpstoxOrderType(
          ((patch.orderType ?? 'MARKET').toUpperCase() as CtsOrderType) ?? 'MARKET',
        ),
        validity: 'DAY',
        price:
          patch.price !== null && (orderType === 'LIMIT' || orderType === 'SL')
            ? patch.price
            : 0,
        trigger_price:
          patch.triggerPrice !== null &&
          (orderType === 'SL' || orderType === 'SL-M')
            ? patch.triggerPrice
            : 0,
      };
      return adapter.modifyOrder(position.brokerOrderId, payload);
    }

    throw new BadRequestException(
      `Broker ${position.broker} does not support modify from the admin console`,
    );
  }

  private async callMasterCancel(position: PositionRecord): Promise<unknown> {
    const accessToken = await this.loadAccessToken(position);

    if (position.broker === Broker.ZERODHA) {
      const adapter = new ZerodhaAdapter();
      adapter.setAccessToken(accessToken);
      return adapter.cancelOrder(position.brokerOrderId);
    }

    if (position.broker === Broker.FYERS) {
      const adapter = new FyersAdapter();
      adapter.setAccessToken(accessToken);
      return adapter.cancelOrder(position.brokerOrderId);
    }

    if (position.broker === Broker.ICICI_DIRECT) {
      const adapter = await this.buildIciciAdapter(position, accessToken);
      return adapter.cancelOrder(position.brokerOrderId, position.exchange ?? 'NSE');
    }

    if (position.broker === Broker.UPSTOX) {
      const adapter = await this.buildUpstoxAdapter(position, accessToken);
      return adapter.cancelOrder(position.brokerOrderId);
    }

    throw new BadRequestException(
      `Broker ${position.broker} does not support cancel from the admin console`,
    );
  }

  private async callMasterExit(
    position: PositionRecord,
    exitQuantity: number,
  ): Promise<unknown> {
    const accessToken = await this.loadAccessToken(position);

    if (position.broker === Broker.ZERODHA) {
      const adapter = new ZerodhaAdapter();
      adapter.setAccessToken(accessToken);
      const order: Record<string, unknown> = {
        exchange: position.exchange,
        tradingsymbol: position.symbol,
        transaction_type: position.side === 'BUY' ? 'SELL' : 'BUY',
        quantity: exitQuantity,
        product: position.productType ?? 'MIS',
        order_type: 'MARKET',
        validity: 'DAY',
      };
      return adapter.placeOrder(order);
    }

    if (position.broker === Broker.FYERS) {
      const adapter = new FyersAdapter();
      adapter.setAccessToken(accessToken);
      const order = {
        symbol: position.symbol,
        qty: exitQuantity,
        type: 2, // MARKET
        side: position.side === 'BUY' ? -1 : 1,
        productType: position.productType ?? 'INTRADAY',
        limitPrice: 0,
        stopPrice: 0,
        disclosedQty: 0,
        validity: 'DAY',
        offlineOrder: false,
      };
      return adapter.placeOrder(order);
    }

    if (position.broker === Broker.ICICI_DIRECT) {
      const adapter = await this.buildIciciAdapter(position, accessToken);
      const instrument = await this.resolveInstrumentForPosition(position);
      const order = buildIciciPlaceOrder({
        stockCode: position.symbol,
        exchange: position.exchange ?? 'NSE',
        // An exit is the opposite side of the open position.
        side: position.side === 'BUY' ? 'SELL' : 'BUY',
        orderType: 'MARKET',
        quantity: exitQuantity,
        validity: 'DAY',
        instrument,
        remark: 'CTS Exit',
      });
      return adapter.placeOrder(order);
    }

    if (position.broker === Broker.UPSTOX) {
      const adapter = await this.buildUpstoxAdapter(position, accessToken);
      const instrumentToken = await this.resolveUpstoxToken(position);
      const order = buildUpstoxPlaceOrder({
        instrumentToken,
        // An exit is the opposite side of the open position.
        side: position.side === 'BUY' ? 'SELL' : 'BUY',
        orderType: 'MARKET',
        quantity: exitQuantity,
        product: (position.productType as any) === 'I' ? 'MIS' : 'CNC',
        validity: 'DAY',
        tag: 'CTSExit',
      });
      return adapter.placeOrder(order);
    }


    throw new BadRequestException(
      `Broker ${position.broker} does not support exit from the admin console`,
    );
  }

  /** Build a credentialed Upstox adapter for order actions. */
  private async buildUpstoxAdapter(
    position: PositionRecord,
    accessToken: string,
  ): Promise<UpstoxAdapter> {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: position.masterAccountId },
    });
    const adapter = new UpstoxAdapter();
    adapter.setCredentials(
      account?.encryptedApiKey
        ? this.encryption.decrypt(account.encryptedApiKey)
        : '',
      account?.encryptedApiSecret
        ? this.encryption.decrypt(account.encryptedApiSecret)
        : '',
    );
    adapter.setAccessToken(accessToken);
    return adapter;
  }

  /** Resolve the Upstox instrument_token for a tracked position. */
  private async resolveUpstoxToken(position: PositionRecord): Promise<string> {
    const mapping = await this.prisma.instrumentBroker.findFirst({
      where: {
        broker: Broker.UPSTOX,
        brokerSymbol: position.symbol,
        exchange: position.exchange ?? 'NSE',
      },
      select: { brokerToken: true },
    });
    return mapping?.brokerToken ?? position.symbol;
  }

  /** Build a credentialed ICICI Direct (Breeze) adapter for order actions. */
  private async buildIciciAdapter(
    position: PositionRecord,
    accessToken: string,
  ): Promise<ICICIDirectAdapter> {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: position.masterAccountId },
    });
    const adapter = new ICICIDirectAdapter();
    adapter.setCredentials(
      account?.encryptedApiKey
        ? this.encryption.decrypt(account.encryptedApiKey)
        : '',
      account?.encryptedApiSecret
        ? this.encryption.decrypt(account.encryptedApiSecret)
        : '',
    );
    adapter.setSessionToken(accessToken);
    return adapter;
  }

  /**
   * Resolve the broker-neutral instrument facts for a tracked position so the
   * shared ICICI mapper can pick the correct product / right / strike / expiry.
   * Best-effort: a missing mapping falls back to cash-equity defaults inside
   * the mapper. Sprint 6.2.8.
   */
  private async resolveInstrumentForPosition(
    position: PositionRecord,
  ): Promise<ResolvedInstrument | null> {
    const mapping = await this.resolver.resolveByBrokerSymbol(
      position.broker,
      position.symbol,
      position.exchange,
    );
    if (!mapping) return null;
    return {
      contractKey: mapping.instrument.contractKey,
      exchange: mapping.instrument.exchange,
      segment: mapping.instrument.segment,
      instrumentType: mapping.instrument.instrumentType,
      optionType: mapping.instrument.optionType ?? null,
      strike: mapping.instrument.strike ?? null,
      expiry: mapping.instrument.expiry
        ? mapping.instrument.expiry.toISOString()
        : null,
      underlying: mapping.instrument.underlying,
    };
  }

  private async loadAccessToken(position: PositionRecord): Promise<string> {
    const session = await this.prisma.brokerSession.findFirst({
      where: {
        tradingAccountId: position.masterAccountId,
        broker: position.broker,
      },
    });
    if (!session) {
      throw new NotFoundException(
        `No broker session for master account ${position.masterAccountId} on ${position.broker}`,
      );
    }
    return this.encryption.decrypt(session.encryptedAccessToken);
  }

  // -------------------------------------------------------------------------
  // Lifecycle handoff
  // -------------------------------------------------------------------------

  private buildEvent(
    position: PositionRecord,
    type: LifecycleEventType,
    patch: {
      quantity: number;
      price: number | null;
      triggerPrice: number | null;
      orderType: string | null;
      rawStatus: string;
      reason?: string | null;
      brokerResponse: unknown;
    },
  ): LifecycleEvent {
    return {
      type,
      broker: position.broker,
      masterAccountId: position.masterAccountId,
      brokerOrderId: position.brokerOrderId,
      symbol: position.symbol,
      exchange: position.exchange,
      side: position.side,
      quantity: patch.quantity,
      filledQuantity: position.filledQuantity,
      pendingQuantity: Math.max(0, patch.quantity - position.filledQuantity),
      price: patch.price,
      triggerPrice: patch.triggerPrice,
      orderType: patch.orderType,
      productType: position.productType,
      rawStatus: patch.rawStatus,
      brokerUpdatedAt: new Date().toISOString(),
      reason: patch.reason ?? null,
      raw: patch.brokerResponse,
    };
  }

  private async applyAndFinalize(
    action: OrderActionType,
    key: string,
    event: LifecycleEvent,
    tradeSource: string,
    brokerResponse: unknown,
  ): Promise<OrderActionResult> {
    const outcome = await this.lifecycle.ingestAdminEvent(event, {
      tradeSource,
    });

    if (!outcome.accepted) {
      // Master broker already accepted the action but the lifecycle
      // layer refused the transition (e.g. concurrent state change).
      // Surface the reason without rolling back — the broker is the
      // ultimate source of truth and the next master-watcher poll
      // will re-align the registry.
      this.logger.warn(
        `${action} for ${key} accepted by broker but lifecycle refused: ${outcome.reason}`,
      );
    }

    return {
      action,
      key: outcome.key || key,
      accepted: outcome.accepted,
      previousState: outcome.previousState,
      nextState: outcome.nextState,
      reason: outcome.reason,
      brokerResponse,
      followerSync: outcome.followerSync,
    };
  }
}

// ---------------------------------------------------------------------------
// Local Fyers helpers — kept private to the service so we do not
// re-export another broker mapping utility. Mirrors the vocabulary
// used by ManualTradeService.
// ---------------------------------------------------------------------------

function mapIciciOrderType(orderType: string | null): string {
  switch ((orderType ?? '').toUpperCase()) {
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


function mapFyersOrderTypeCode(orderType: string | null): number {
  const t = (orderType ?? '').toUpperCase();
  if (t === 'LIMIT') return 1;
  if (t === 'MARKET') return 2;
  if (t === 'SL-M') return 3;
  if (t === 'SL') return 4;
  return 2;
}
