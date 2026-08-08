import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { BrokerService } from '../brokers/broker.service';
import { PositionLifecycleService } from '../position-lifecycle/position-lifecycle.service';
import { Broker } from '@prisma/client';
import { LifecycleEventType } from '../position-lifecycle/lifecycle.types';

/**
 * Master Sync — reconciles a single master account against its OWN broker
 * on demand and forwards each raw order into the position-lifecycle pipeline.
 *
 * Sprint 6.2.12 — the previous continuous background poller (an
 * `OnModuleInit` `setInterval` loop over every connected master) has been
 * removed. Synchronization is now strictly manual: it runs once after a
 * successful CTS manual trade, and once whenever the operator clicks
 * "Sync Now" (POST /masters/:id/sync). There is no timer, interval,
 * scheduler or background execution — a sync is a single reconciliation
 * cycle triggered explicitly.
 *
 * The detection logic itself is unchanged from the former `pollMaster`:
 * resolve the account's credentialed adapter via `BrokerService`, fetch the
 * broker order book, and push every order through
 * `PositionLifecycleService.ingest` (which owns deduplication, state-machine
 * validation and the follower fan-out decision). Only the trigger changed.
 */
@Injectable()
export class MasterWatcherService {
  private readonly logger = new Logger(MasterWatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerService: BrokerService,
    private readonly lifecycle: PositionLifecycleService,
  ) {}

  /**
   * Run exactly one synchronization cycle for a single master account.
   *
   * Fetches the broker order book, discovers new / modified / closed trades
   * and creates copy jobs through the existing lifecycle pipeline, then
   * returns a concise summary of what the cycle produced.
   */
  async syncMaster(tradingAccountId: string): Promise<MasterSyncResult> {
    const startedAt = Date.now();
    const result: MasterSyncResult = {
      masterId: tradingAccountId,
      broker: null,
      newTrades: 0,
      modifiedTrades: 0,
      closedTrades: 0,
      copyJobsCreated: 0,
      durationMs: 0,
    };

    const strategy = await this.prisma.strategy.findFirst({
      where: {
        tradingAccountId,
        enabled: true,
        status: 'ACTIVE',
      },
    });

    if (!strategy) {
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    const followerCount = await this.prisma.follower.count({
      where: {
        strategyId: strategy.id,
        enabled: true,
      },
    });

    if (followerCount === 0) {
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // Broker-aware adapter resolution — uses the account's OWN broker
    // (Zerodha / Fyers / ICICI / Shoonya) with the correct credentials.
    let resolved: Awaited<ReturnType<BrokerService['getAdapterForAccount']>>;
    try {
      resolved = await this.brokerService.getAdapterForAccount(tradingAccountId);
    } catch (e: any) {
      this.logger.warn(
        `Unable to build adapter for master ${tradingAccountId}: ${e?.message ?? e}`,
      );
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    if (!resolved) {
      // No broker session persisted for this account — nothing to sync.
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    const { broker, adapter } = resolved;
    result.broker = broker;

    let orders: any[] = [];
    try {
      const raw = await (adapter as any).getOrders();
      orders = BrokerService.toOrderArray(raw);
    } catch (e: any) {
      this.logger.warn(
        `Unable to fetch ${broker} orders for master ${tradingAccountId}: ${e?.message ?? e}`,
      );
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // Every broker order (regardless of status) is forwarded to the
    // position-lifecycle manager. The manager owns deduplication (via the
    // position registry's signature gate), state-machine validation, and the
    // fan-out decision.
    for (const order of orders) {
      const outcome = await this.lifecycle.ingest(
        { broker, tradingAccountId },
        order,
      );
      if (!outcome.accepted || !outcome.event) {
        continue;
      }
      this.tally(result, outcome.event.type, outcome.followerSync.length);
    }

    result.durationMs = Date.now() - startedAt;

    this.logger.log(
      `Master Sync — broker=${broker} new=${result.newTrades} ` +
        `modified=${result.modifiedTrades} closed=${result.closedTrades} ` +
        `copyJobs=${result.copyJobsCreated} duration=${result.durationMs}ms`,
    );

    return result;
  }

  /** Bucket one accepted lifecycle transition into the summary counters. */
  private tally(
    result: MasterSyncResult,
    type: LifecycleEventType,
    followerSyncCount: number,
  ): void {
    switch (type) {
      case LifecycleEventType.NEW:
      case LifecycleEventType.PARTIAL_FILL:
      case LifecycleEventType.COMPLETE_FILL:
        result.newTrades += 1;
        break;
      case LifecycleEventType.ORDER_MODIFY:
      case LifecycleEventType.STOP_LOSS_MODIFY:
      case LifecycleEventType.TARGET_MODIFY:
        result.modifiedTrades += 1;
        break;
      case LifecycleEventType.CANCEL:
      case LifecycleEventType.EXIT:
      case LifecycleEventType.POSITION_CLOSED:
        result.closedTrades += 1;
        break;
      default:
        break;
    }

    // A COMPLETE_FILL delegates the entry fan-out to CopyTradingService
    // (one copy job); MODIFY / CANCEL / EXIT produce one follower-sync job
    // per affected follower order.
    if (type === LifecycleEventType.COMPLETE_FILL) {
      result.copyJobsCreated += 1;
    } else {
      result.copyJobsCreated += followerSyncCount;
    }
  }
}

/**
 * Summary returned by one `syncMaster` reconciliation cycle.
 */
export interface MasterSyncResult {
  masterId: string;
  broker: Broker | null;
  newTrades: number;
  modifiedTrades: number;
  closedTrades: number;
  copyJobsCreated: number;
  durationMs: number;
}
