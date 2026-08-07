import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { BrokerService } from '../brokers/broker.service';
import { PositionLifecycleService } from '../position-lifecycle/position-lifecycle.service';
import { AccountType } from '@prisma/client';

/**
 * Master Watcher — polls every CONNECTED master account's OWN broker and
 * forwards each raw order into the position-lifecycle pipeline.
 *
 * Sprint 6.2.8 — previously this service was hardcoded to Zerodha (session
 * lookup, `new ZerodhaAdapter()`, and the lifecycle `broker` tag), so ICICI /
 * Fyers / Shoonya masters were NEVER polled — the root cause of "trades placed
 * directly in the ICICI terminal are not detected". It now resolves the
 * matching credentialed adapter per account via `BrokerService` and handles
 * each broker's `getOrders()` envelope shape.
 */
@Injectable()
export class MasterWatcherService implements OnModuleInit {
  private readonly logger = new Logger(MasterWatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerService: BrokerService,
    private readonly lifecycle: PositionLifecycleService,
  ) {}

  onModuleInit() {
    this.logger.log('Master Watcher Started');

    setInterval(() => {
      this.pollMasters().catch((err) =>
        this.logger.error(`pollMasters failed: ${err?.message ?? err}`),
      );
    }, 3000);
  }

  async pollMasters() {
    const masters = await this.prisma.tradingAccount.findMany({
      where: {
        accountType: AccountType.MASTER,
        enabled: true,
        connectionStatus: 'CONNECTED',
      },
    });

    for (const master of masters) {
      await this.pollMaster(master.id);
    }
  }

  async pollMaster(tradingAccountId: string) {
    const strategy = await this.prisma.strategy.findFirst({
      where: {
        tradingAccountId,
        enabled: true,
        status: 'ACTIVE',
      },
    });

    if (!strategy) {
      return;
    }

    const followerCount = await this.prisma.follower.count({
      where: {
        strategyId: strategy.id,
        enabled: true,
      },
    });

    if (followerCount === 0) {
      return;
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
      return;
    }

    if (!resolved) {
      // No broker session persisted for this account — nothing to poll.
      return;
    }

    const { broker, adapter } = resolved;

    let orders: any[] = [];
    try {
      const raw = await (adapter as any).getOrders();
      orders = BrokerService.toOrderArray(raw);
    } catch (e: any) {
      this.logger.warn(
        `Unable to fetch ${broker} orders for master ${tradingAccountId}: ${e?.message ?? e}`,
      );
      return;
    }

    // Every broker order (regardless of status) is forwarded to the
    // position-lifecycle manager. The manager owns deduplication (via the
    // position registry's signature gate), state-machine validation, and the
    // fan-out decision.
    for (const order of orders) {
      await this.lifecycle.ingest({ broker, tradingAccountId }, order);
    }
  }
}
