import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { FyersAdapter } from '../brokers/fyers/fyers.adapter';
import { ExecutionEventRecorderService } from '../copy-trading/execution-event.recorder';
import { classifyFailure } from '../copy-trading/execution-event.recorder';

import { PositionRegistryService } from './position-registry.service';
import {
  FollowerOrderLink,
  FollowerSyncOutcome,
  LifecycleEvent,
  LifecycleEventType,
  PositionRecord,
} from './lifecycle.types';

/**
 * Sprint 5.3 — Position Synchronization Engine.
 *
 * Given a lifecycle event on a master position and the follower orders
 * currently mirroring it, this engine performs the corresponding
 * broker-side action on every follower and records the outcome through
 * the same ExecutionEventRecorderService used by CopyTradingService so
 * every synchronization attempt lands in the permanent execution_history
 * audit trail alongside the original fan-out.
 *
 * Design notes:
 *   - Follower actions today target the Fyers adapter only, matching
 *     the copy-trading MVP scope (`CopyTradingService` skips
 *     non-Fyers followers with BROKER_UNSUPPORTED). If more broker
 *     adapters gain modify/cancel implementations later, this engine
 *     picks them up simply by extending the switch — no schema or
 *     controller changes required.
 *   - Duplicate synchronization is prevented at two layers:
 *       1. `PositionRegistryService.hasSignatureChanged` — a broker
 *          echo with an unchanged status/qty/price does not enter
 *          this engine at all.
 *       2. `PositionRecord.followers[].lastAction` — the registry
 *          keeps per-follower bookkeeping so a caller can inspect
 *          what was last applied.
 */
@Injectable()
export class PositionSynchronizationService {
  private readonly logger = new Logger(PositionSynchronizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly registry: PositionRegistryService,
    private readonly recorder: ExecutionEventRecorderService,
  ) {}

  /**
   * Apply a MODIFY / STOP_LOSS_MODIFY / TARGET_MODIFY to every follower
   * order tracked on the given master position.
   */
  async syncModify(
    event: LifecycleEvent,
    position: PositionRecord,
  ): Promise<FollowerSyncOutcome[]> {
    return this.dispatch(event, position, 'MODIFY', async (adapter, link) =>
      adapter.modifyOrder(link.brokerOrderId, {
        id: link.brokerOrderId,
        qty: link.quantity ?? event.quantity,
        type: mapFyersOrderType(event.orderType),
        limitPrice: event.price ?? 0,
        stopPrice: event.triggerPrice ?? 0,
      }),
    );
  }

  /**
   * Apply a CANCEL to every follower order tracked on the given master
   * position. A follower whose order is already in a terminal state
   * broker-side will surface a BROKER_ERROR outcome — the audit trail
   * records the raw response verbatim.
   */
  async syncCancel(
    event: LifecycleEvent,
    position: PositionRecord,
  ): Promise<FollowerSyncOutcome[]> {
    return this.dispatch(event, position, 'CANCEL', async (adapter, link) =>
      adapter.cancelOrder(link.brokerOrderId),
    );
  }

  /**
   * Apply an EXIT to every follower order tracked on the given master
   * position. The exit is a reverse trade for the currently-open
   * follower quantity (a MARKET order in the opposite direction),
   * placed on the same follower symbol that was used for entry.
   */
  async syncExit(
    event: LifecycleEvent,
    position: PositionRecord,
  ): Promise<FollowerSyncOutcome[]> {
    const reverseSide = event.side === 'BUY' ? -1 : 1;
    return this.dispatch(event, position, 'EXIT', async (adapter, link) =>
      adapter.placeOrder({
        symbol: link.followerSymbol ?? position.symbol,
        qty: link.quantity ?? event.quantity,
        type: 2, // MARKET
        side: reverseSide,
        productType: 'INTRADAY',
        limitPrice: 0,
        stopPrice: 0,
        disclosedQty: 0,
        validity: 'DAY',
        offlineOrder: false,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Dispatch loop
  // -------------------------------------------------------------------------

  private async dispatch(
    event: LifecycleEvent,
    position: PositionRecord,
    action: 'MODIFY' | 'CANCEL' | 'EXIT',
    call: (adapter: FyersAdapter, link: FollowerOrderLink) => Promise<any>,
  ): Promise<FollowerSyncOutcome[]> {
    if (position.followers.length === 0) {
      this.logger.log(
        `Lifecycle ${event.type} on ${event.symbol} — no follower orders tracked, nothing to sync`,
      );
      return [];
    }

    // One recorder builder per sync fan-out so each follower attempt
    // is persisted alongside the master trade in execution_history.
    // We tag `tradeSource` with the lifecycle event type so operators
    // can filter the audit trail by lifecycle vs. initial fan-out.
    const master = await this.prisma.tradingAccount.findUnique({
      where: { id: event.masterAccountId },
      select: { nickname: true },
    });

    const builder = this.recorder.begin({
      masterAccountId: event.masterAccountId,
      masterAccountNickname: master?.nickname ?? null,
      broker: event.broker,
      symbol: event.symbol,
      side: event.side,
      quantity: event.quantity,
      price: event.price ?? null,
      productType: event.productType ?? '',
      orderType: event.orderType ?? null,
      tradeSource: `LIFECYCLE_${event.type}`,
      masterExchange: event.exchange,
      masterSegment: null,
      orderId: event.brokerOrderId,
      timestamp: event.brokerUpdatedAt ?? new Date().toISOString(),
    });
    builder.setStrategy(
      position.strategyId ? { id: position.strategyId, name: '' } : null,
    );
    builder.setFollowersFound(position.followers.length);

    const outcomes: FollowerSyncOutcome[] = [];

    try {
      for (const link of position.followers) {
        const rec = builder.addFollower({
          followerId: link.followerId ?? link.followerAccountId,
          followerName: link.followerEmail ?? link.followerAccountId,
          followerEmail: link.followerEmail ?? '',
          followerAccountId: link.followerAccountId,
          broker: link.broker,
        });
        rec.setBrokerSymbol(link.followerSymbol);
        rec.setQuantity(link.quantity ?? null);

        if (link.broker !== Broker.FYERS) {
          rec.skip(
            'BROKER_UNSUPPORTED',
            `Broker ${link.broker} does not yet support lifecycle sync (Fyers only)`,
          );
          outcomes.push({
            followerAccountId: link.followerAccountId,
            followerEmail: link.followerEmail,
            brokerOrderId: link.brokerOrderId,
            ok: false,
            action,
            reason: `Broker ${link.broker} not supported for lifecycle sync`,
            brokerResponse: null,
          });
          this.registry.updateFollowerLink(
            position.key,
            link.followerAccountId,
            link.brokerOrderId,
            {
              lastAction: action,
              lastActionAt: new Date().toISOString(),
              lastActionOk: false,
              lastActionMessage: `Broker ${link.broker} not supported`,
            },
          );
          continue;
        }

        const session = await this.prisma.brokerSession.findFirst({
          where: {
            tradingAccountId: link.followerAccountId,
            broker: Broker.FYERS,
          },
        });

        if (!session) {
          rec.skip(
            'NO_BROKER_SESSION',
            'No broker session on follower trading account',
          );
          outcomes.push({
            followerAccountId: link.followerAccountId,
            followerEmail: link.followerEmail,
            brokerOrderId: link.brokerOrderId,
            ok: false,
            action,
            reason: 'No broker session on follower trading account',
            brokerResponse: null,
          });
          this.registry.updateFollowerLink(
            position.key,
            link.followerAccountId,
            link.brokerOrderId,
            {
              lastAction: action,
              lastActionAt: new Date().toISOString(),
              lastActionOk: false,
              lastActionMessage: 'No broker session',
            },
          );
          continue;
        }

        const adapter = new FyersAdapter();
        adapter.setAccessToken(
          this.encryption.decrypt(session.encryptedAccessToken),
        );

        rec.setStatus('EXECUTING');

        try {
          const response = await call(adapter, link);
          const ok =
            !!response &&
            typeof response === 'object' &&
            (response as any).s === 'ok';

          if (ok) {
            rec.succeed(response);
            outcomes.push({
              followerAccountId: link.followerAccountId,
              followerEmail: link.followerEmail,
              brokerOrderId: link.brokerOrderId,
              ok: true,
              action,
              reason: null,
              brokerResponse: response,
            });
            this.registry.updateFollowerLink(
              position.key,
              link.followerAccountId,
              link.brokerOrderId,
              {
                lastAction: action,
                lastActionAt: new Date().toISOString(),
                lastActionOk: true,
                lastActionMessage: null,
              },
            );
          } else {
            const message =
              (response as any)?.message ??
              (typeof response === 'string'
                ? response
                : 'Broker returned non-ok response');
            rec.fail(
              classifyFailure({ message, response }),
              message,
              response,
            );
            outcomes.push({
              followerAccountId: link.followerAccountId,
              followerEmail: link.followerEmail,
              brokerOrderId: link.brokerOrderId,
              ok: false,
              action,
              reason: message,
              brokerResponse: response,
            });
            this.registry.updateFollowerLink(
              position.key,
              link.followerAccountId,
              link.brokerOrderId,
              {
                lastAction: action,
                lastActionAt: new Date().toISOString(),
                lastActionOk: false,
                lastActionMessage: message,
              },
            );
          }
        } catch (err: any) {
          const message = err?.message ?? `Unhandled ${action.toLowerCase()} error`;
          rec.fail(
            classifyFailure({ message, response: err }),
            message,
            { name: err?.name, message },
          );
          outcomes.push({
            followerAccountId: link.followerAccountId,
            followerEmail: link.followerEmail,
            brokerOrderId: link.brokerOrderId,
            ok: false,
            action,
            reason: message,
            brokerResponse: null,
          });
          this.registry.updateFollowerLink(
            position.key,
            link.followerAccountId,
            link.brokerOrderId,
            {
              lastAction: action,
              lastActionAt: new Date().toISOString(),
              lastActionOk: false,
              lastActionMessage: message,
            },
          );
        }
      }
    } finally {
      builder.commit();
    }

    return outcomes;
  }
}

/**
 * Fyers order-type mapping — accepts the strings the master watcher
 * commonly forwards ("MARKET", "LIMIT", "SL", "SL-M") and maps them to
 * Fyers numeric codes. Defaults to MARKET (2) when unknown so a modify
 * with only a price change on a market order still lands.
 */
function mapFyersOrderType(orderType: string | null): number {
  const t = (orderType ?? '').toUpperCase();
  if (t.includes('SL-M') || t === 'SLM') return 4;
  if (t.startsWith('SL')) return 3;
  if (t === 'LIMIT' || t.includes('LIMIT')) return 1;
  if (t === 'MARKET' || t === '' ) return 2;
  return 2;
}
