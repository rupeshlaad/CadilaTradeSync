import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from '../brokers/zerodha/zerodha.adapter';
import { CopyTradingService } from '../copy-trading/copy-trading.service';
import { AccountType, Broker } from '@prisma/client';
import type { TradeEvent } from '../copy-trading/dto/trade-event.dto';

@Injectable()
export class MasterWatcherService implements OnModuleInit {
  private readonly logger = new Logger(MasterWatcherService.name);

  private readonly seenOrders = new Map<string, Set<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly copyTrading: CopyTradingService,
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

    let cache = this.seenOrders.get(tradingAccountId);

    if (!cache) {
      cache = new Set<string>();
      this.seenOrders.set(tradingAccountId, cache);
    }

    for (const order of orders) {
      // Only completed orders
      if (order.status !== 'COMPLETE') {
        continue;
      }

      // Ignore duplicates
      if (cache.has(order.order_id)) {
        continue;
      }

      cache.add(order.order_id);

      this.logger.log(
        `MASTER ORDER ${order.transaction_type} ${order.tradingsymbol}`,
      );

      await this.copyTrading.handleTrade({
        broker: 'ZERODHA',
        tradingAccountId,
        orderId: order.order_id,
        exchange: order.exchange,
        symbol: order.tradingsymbol,
        side: order.transaction_type,
        quantity: order.quantity,
        orderType: order.order_type,
        product: order.product,
        price: Number(order.average_price ?? order.price ?? 0),
        status: order.status,
        timestamp: new Date(order.exchange_timestamp ?? Date.now()),
      });
    }
  }
}