import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from '../brokers/zerodha/zerodha.adapter';
import { PositionLifecycleService } from '../position-lifecycle/position-lifecycle.service';
import { AccountType, Broker } from '@prisma/client';

@Injectable()
export class MasterWatcherService implements OnModuleInit {
  private readonly logger = new Logger(MasterWatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly lifecycle: PositionLifecycleService,
  ) {}

  onModuleInit() {
    this.logger.log('Master Watcher Started');

    setInterval(() => {
      this.pollMasters().catch(console.error);
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

    const session = await this.prisma.brokerSession.findFirst({
      where: {
        tradingAccountId,
        broker: Broker.ZERODHA,
      },
    });

    if (!session) {
      return;
    }

    const adapter = new ZerodhaAdapter();

    adapter.setAccessToken(
      this.encryption.decrypt(
        session.encryptedAccessToken,
      ),
    );

    let orders: any[] = [];

    try {
      orders = await adapter.getOrders();
    } catch (e: any) {
      this.logger.warn(
        `Unable to fetch Zerodha orders: ${e.message}`,
      );
      return;
    }

    // Sprint 5.3 — every broker order (regardless of status) is
    // forwarded to the position-lifecycle manager. The manager owns
    // deduplication (via the position registry's signature gate),
    // state-machine validation, and the fan-out decision:
    //   - a fresh COMPLETE_FILL still triggers CopyTradingService,
    //     preserving pre-lifecycle entry-trade behaviour.
    //   - modifications, cancellations and exits go through the
    //     synchronization engine and are audited in execution_history.
    for (const order of orders) {
      await this.lifecycle.ingest(
        { broker: Broker.ZERODHA, tradingAccountId },
        order,
      );
    }
  }
}
