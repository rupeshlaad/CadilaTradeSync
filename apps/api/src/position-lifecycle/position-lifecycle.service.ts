import { Injectable, Logger } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { CopyTradingService } from '../copy-trading/copy-trading.service';

import { PositionRegistryService } from './position-registry.service';
import { PositionSynchronizationService } from './position-synchronization.service';
import {
  computeSignature,
  deriveLifecycleEvent,
  normalizeRawOrder,
} from './broker-lifecycle-normalizer';
import { decideTransition } from './lifecycle-state-machine';
import {
  buildFollowerSyncEntry,
  buildRejectionEntry,
  buildTransitionEntry,
} from './lifecycle-timeline';
import {
  LifecycleEvent,
  LifecycleEventType,
  LifecycleIngestOutcome,
  PositionState,
} from './lifecycle.types';
import {
  traceStage,
  currentManualTradeTrace,
} from '../observability/manual-trade-trace';

/**
 * Sprint 5.3 — Position Lifecycle Manager.
 *
 * Single entry point for every broker-side order transition on a
 * master account. Upstream broker listeners (currently
 * `MasterWatcherService`) call `ingest()` once per raw order per poll
 * — the manager takes care of:
 *
 *   1. Normalizing the payload into a canonical `LifecycleEvent`.
 *   2. Deduplicating unchanged broker echoes via the position registry.
 *   3. Validating the transition through the lifecycle state machine
 *      so illegal / stale events are rejected (never propagated).
 *   4. Deciding the follower action:
 *        - COMPLETE_FILL on a fresh position → delegate to
 *          `CopyTradingService.handleTrade()` (existing entry fan-out).
 *        - ORDER_MODIFY / *_MODIFY → PositionSynchronizationService.syncModify
 *        - CANCEL → PositionSynchronizationService.syncCancel
 *        - EXIT / POSITION_CLOSED → PositionSynchronizationService.syncExit
 *        - NEW / PARTIAL_FILL / REJECT → timeline-only bookkeeping.
 *   5. Recording every decision on the position's lifecycle timeline.
 *
 * The manager is intentionally event-driven and has no scheduler of
 * its own — polling is upstream in the broker listener and every call
 * to `ingest()` is one broker-observed transition.
 */
@Injectable()
export class PositionLifecycleService {
  private readonly logger = new Logger(PositionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PositionRegistryService,
    private readonly sync: PositionSynchronizationService,
    private readonly copyTrading: CopyTradingService,
  ) {}

  /**
   * Push a single raw broker order through the lifecycle pipeline.
   * Returns a structured outcome so upstream callers can log without
   * needing to reach into the registry directly.
   *
   * The context.tradingAccountId MUST already be the internal
   * TradingAccount.id (the broker listener that produced the order
   * already knows which of its subscriptions it belongs to).
   */
  async ingest(
    context: {
      broker: Broker;
      tradingAccountId: string;
      /**
       * Optional trade-source label forwarded to CopyTradingService
       * when the manager delegates a fresh COMPLETE_FILL. Defaults to
       * `BROKER_POLL` for the master-watcher path; the manual-trading
       * pipeline passes `MANUAL` so the same fan-out lands in the
       * execution-history audit trail tagged as an admin-initiated
       * trade.
       */
      tradeSource?: string;
    },
    rawOrder: unknown,
  ): Promise<LifecycleIngestOutcome> {
    const normalized = normalizeRawOrder(context.broker, rawOrder);
    if (!normalized) {
      traceStage(5, {
        component: 'PositionLifecycleService',
        method: 'ingest',
        input: {
          broker: context.broker,
          tradeSource: context.tradeSource ?? 'BROKER_POLL',
        },
        output: { accepted: false, reason: 'Unable to normalize broker payload' },
        status: 'NORMALIZE_FAILED',
      });
      return {
        key: '',
        accepted: false,
        event: null,
        previousState: null,
        nextState: null,
        reason: 'Unable to normalize broker payload',
        followerSync: [],
      };
    }

    const key = this.registry.buildKey(
      context.broker,
      context.tradingAccountId,
      normalized.brokerOrderId,
    );

    const signature = computeSignature(normalized);
    if (!this.registry.hasSignatureChanged(key, signature)) {
      // Broker echo with no state change — no-op.
      traceStage(5, {
        component: 'PositionLifecycleService',
        method: 'ingest',
        input: {
          broker: context.broker,
          brokerOrderId: normalized.brokerOrderId,
          symbol: normalized.symbol,
          tradeSource: context.tradeSource ?? 'BROKER_POLL',
        },
        output: {
          accepted: false,
          brokerStatus: normalized.status,
          positionId: key,
          reason: 'Signature unchanged (duplicate broker echo)',
        },
        status: 'SIGNATURE_UNCHANGED',
        relatedIds: { brokerOrderId: normalized.brokerOrderId, masterPositionId: key },
      });
      return {
        key,
        accepted: false,
        event: null,
        previousState: this.registry.get(key)?.state ?? null,
        nextState: this.registry.get(key)?.state ?? null,
        reason: 'Signature unchanged',
        followerSync: [],
      };
    }

    const previousState = this.registry.get(key)?.state ?? null;
    const previousSignature = this.registry.get(key)?.lastSignature ?? null;

    const event = deriveLifecycleEvent(
      { broker: context.broker, masterAccountId: context.tradingAccountId },
      normalized,
      previousSignature,
    );

    if (!event) {
      // The normalizer decided nothing changed materially. Remember the
      // signature so we don't reconsider this echo.
      this.registry.rememberSignature(key, signature);
      traceStage(5, {
        component: 'PositionLifecycleService',
        method: 'ingest',
        input: {
          broker: context.broker,
          brokerOrderId: normalized.brokerOrderId,
          symbol: normalized.symbol,
          tradeSource: context.tradeSource ?? 'BROKER_POLL',
        },
        output: {
          accepted: false,
          brokerStatus: normalized.status,
          reason: 'No lifecycle event derived from broker payload',
        },
        status: 'NO_EVENT',
        relatedIds: { brokerOrderId: normalized.brokerOrderId, masterPositionId: key },
      });
      return {
        key,
        accepted: false,
        event: null,
        previousState,
        nextState: previousState,
        reason: 'No lifecycle event derived from broker payload',
        followerSync: [],
      };
    }

    // Validate the transition against the state machine.
    const decision = decideTransition(previousState, event.type);
    if (!decision.ok || !decision.nextState) {
      const reason = decision.reason ?? 'Illegal lifecycle transition';
      this.logger.warn(
        `Lifecycle event ${event.type} rejected for ${key}: ${reason}`,
      );
      this.registry.rememberSignature(key, signature);
      this.registry.appendTimeline(key, buildRejectionEntry(reason, event));
      traceStage(5, {
        component: 'PositionLifecycleService',
        method: 'ingest',
        input: {
          broker: event.broker,
          brokerOrderId: event.brokerOrderId,
          symbol: event.symbol,
          classification: event.type,
        },
        output: {
          accepted: false,
          transition: `${previousState ?? 'NONE'} -> (rejected)`,
          reason,
        },
        status: 'REJECTED_TRANSITION',
        relatedIds: { brokerOrderId: event.brokerOrderId, masterPositionId: key },
      });
      return {
        key,
        accepted: false,
        event,
        previousState,
        nextState: previousState,
        reason,
        followerSync: [],
      };
    }

    return this.applyAcceptedTransition(
      event,
      previousState,
      decision.nextState,
      signature,
      context.tradeSource,
    );
  }

  /**
   * Sprint 5.5.1 — admin-initiated lifecycle ingestion.
   *
   * Entry point used by the Order-Actions service for a Modify /
   * Cancel / Exit issued from the admin UI. The caller has already
   * placed the corresponding master-broker action and passes a
   * fully-built `LifecycleEvent` describing the resulting state.
   *
   * The event is validated through the SAME state machine, applied
   * to the registry with the SAME timeline & follower-dispatch code
   * path as broker-poll ingestion, so no parallel execution pipeline
   * is introduced. Every downstream side-effect (follower sync via
   * `PositionSynchronizationService`, execution-history persistence
   * via the recorder subscription) fires exactly as it does for a
   * broker-detected transition.
   */
  async ingestAdminEvent(
    event: LifecycleEvent,
    options: { tradeSource?: string } = {},
  ): Promise<LifecycleIngestOutcome> {
    const key = this.registry.buildKey(
      event.broker,
      event.masterAccountId,
      event.brokerOrderId,
    );
    const previousState = this.registry.get(key)?.state ?? null;

    const decision = decideTransition(previousState, event.type);
    if (!decision.ok || !decision.nextState) {
      const reason = decision.reason ?? 'Illegal lifecycle transition';
      this.logger.warn(
        `Admin lifecycle event ${event.type} rejected for ${key}: ${reason}`,
      );
      this.registry.appendTimeline(key, buildRejectionEntry(reason, event));
      return {
        key,
        accepted: false,
        event,
        previousState,
        nextState: previousState,
        reason,
        followerSync: [],
      };
    }

    // Admin-originated events are not derived from a raw broker
    // payload; fabricate a consistent signature so the registry's
    // dedup gate stays coherent for subsequent broker polls.
    const signature = {
      status: event.rawStatus ?? event.type,
      filledQuantity: event.filledQuantity,
      quantity: event.quantity,
      price: event.price,
      triggerPrice: event.triggerPrice,
      brokerUpdatedAt: event.brokerUpdatedAt,
    };

    return this.applyAcceptedTransition(
      event,
      previousState,
      decision.nextState,
      signature,
      options.tradeSource,
    );
  }

  // -------------------------------------------------------------------------
  // Shared apply + dispatch (used by both ingest() and ingestAdminEvent())
  // -------------------------------------------------------------------------

  private async applyAcceptedTransition(
    event: LifecycleEvent,
    previousState: PositionState | null,
    nextState: PositionState,
    signature: import('./lifecycle.types').OrderSignature,
    tradeSource: string | undefined,
  ): Promise<LifecycleIngestOutcome> {
    const key = this.registry.buildKey(
      event.broker,
      event.masterAccountId,
      event.brokerOrderId,
    );

    // Look up the active strategy for the master account so we can
    // pin it on the position record (best-effort — a position can be
    // tracked even before a strategy is active, in which case
    // strategyId stays null).
    const strategyId = await this.lookupStrategyId(event.masterAccountId);

    const timelineEntry = buildTransitionEntry(event, previousState, nextState);
    const record = this.registry.applyEvent(
      event,
      nextState,
      timelineEntry,
      signature,
      strategyId,
    );

    // Dispatch the follower-side action for the accepted lifecycle event.
    const followerSync = await this.dispatchFollowers(event, record, tradeSource);

    // Persist per-follower outcome as additional timeline entries so
    // the Trade Monitor detail page can render them without joining
    // execution_history.
    for (const outcome of followerSync) {
      this.registry.appendTimeline(
        key,
        buildFollowerSyncEntry(
          event,
          outcome.action,
          outcome.followerEmail,
          outcome.ok,
          outcome.reason,
        ),
      );
    }

    // Post-EXIT: if every follower successfully closed, mark the
    // position CLOSED to avoid waiting for a separate broker-side
    // POSITION_CLOSED echo (many broker adapters don't emit one).
    if (
      event.type === LifecycleEventType.EXIT &&
      followerSync.length > 0 &&
      followerSync.every((o) => o.ok)
    ) {
      const closedEntry = buildTransitionEntry(
        event,
        nextState,
        PositionState.CLOSED,
      );
      closedEntry.kind = 'POSITION_CLOSED';
      closedEntry.label = `All followers exited — ${nextState} → CLOSED`;
      this.registry.applyEvent(
        event,
        PositionState.CLOSED,
        closedEntry,
        signature,
        strategyId,
      );
    }

    const resolvedNextState =
      event.type === LifecycleEventType.EXIT &&
      followerSync.length > 0 &&
      followerSync.every((o) => o.ok)
        ? PositionState.CLOSED
        : nextState;

    // Stage 5 — accepted lifecycle transition. Marked against the manual
    // order only when the broker order id matches the traced manual trade.
    const trace = currentManualTradeTrace();
    const isManualOrder =
      !!trace &&
      !!trace.ids.brokerOrderId &&
      event.brokerOrderId === trace.ids.brokerOrderId;
    if (isManualOrder && trace) trace.ids.masterPositionId = key;
    traceStage(
      5,
      {
        component: 'PositionLifecycleService',
        method: 'applyAcceptedTransition',
        input: {
          tradeSource: tradeSource ?? 'BROKER_POLL',
          brokerOrderId: event.brokerOrderId,
          symbol: event.symbol,
        },
        output: {
          classification: event.type,
          transition: `${previousState ?? 'NONE'} -> ${resolvedNextState}`,
          positionId: key,
          followerSyncJobs: followerSync.length,
        },
        status: 'ACCEPTED',
        relatedIds: { masterPositionId: key, brokerOrderId: event.brokerOrderId },
      },
      isManualOrder,
    );

    return {
      key,
      accepted: true,
      event,
      previousState,
      nextState: resolvedNextState,
      reason: null,
      followerSync,
    };
  }

  // -------------------------------------------------------------------------
  // Follower dispatch
  // -------------------------------------------------------------------------

  private async dispatchFollowers(
    event: LifecycleEvent,
    position: ReturnType<PositionRegistryService['applyEvent']>,
    tradeSource?: string,
  ) {
    switch (event.type) {
      case LifecycleEventType.COMPLETE_FILL:
        // Initial entry fan-out for a freshly-filled master order.
        // Delegate to the existing CopyTradingService — this preserves
        // the current audit/behaviour for the first-ever trade on the
        // position while the lifecycle layer takes over subsequent
        // modifications, cancellations and exits.
        await this.copyTrading.handleTrade({
          broker: event.broker,
          tradingAccountId: event.masterAccountId,
          orderId: event.brokerOrderId,
          exchange: event.exchange ?? '',
          symbol: event.symbol,
          side: event.side,
          quantity: event.quantity,
          orderType: event.orderType ?? '',
          product: event.productType ?? '',
          price: event.price ?? 0,
          status: event.rawStatus ?? 'COMPLETE',
          timestamp: event.brokerUpdatedAt
            ? new Date(event.brokerUpdatedAt)
            : new Date(),
          source: tradeSource,
        });
        // The recorder subscription in PositionRegistryService will
        // correlate follower broker order ids into this position
        // automatically once the fan-out commits.
        return [];

      case LifecycleEventType.ORDER_MODIFY:
      case LifecycleEventType.STOP_LOSS_MODIFY:
      case LifecycleEventType.TARGET_MODIFY:
        return this.sync.syncModify(event, position);

      case LifecycleEventType.CANCEL:
        return this.sync.syncCancel(event, position);

      case LifecycleEventType.EXIT:
        return this.sync.syncExit(event, position);

      case LifecycleEventType.POSITION_CLOSED:
      case LifecycleEventType.NEW:
      case LifecycleEventType.PARTIAL_FILL:
      case LifecycleEventType.REJECT:
        return [];

      default:
        return [];
    }
  }

  private async lookupStrategyId(
    tradingAccountId: string,
  ): Promise<string | null> {
    const strategy = await this.prisma.strategy.findFirst({
      where: {
        tradingAccountId,
        masterAccount: true,
        enabled: true,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    return strategy?.id ?? null;
  }
}
