import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from './zerodha/zerodha.adapter';
import { Broker } from '@prisma/client';

@Injectable()
export class BrokerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private async getZerodhaAdapter(accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: {
        id: accountId,
      },
    });

    if (!account) {
      throw new NotFoundException('Trading account not found');
    }

    const session = await this.prisma.brokerSession.findUnique({
      where: {
        tradingAccountId_broker: {
          tradingAccountId: accountId,
          broker: Broker.ZERODHA,
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Broker session not found');
    }

    const adapter = new ZerodhaAdapter();

    adapter.setAccessToken(
      this.encryption.decrypt(
        session.encryptedAccessToken,
      ),
    );

    return adapter;
  }

  async getDashboard(accountId: string) {
    const adapter = await this.getZerodhaAdapter(accountId);

    const [
      profile,
      margins,
      holdings,
      positions,
      orders,
      trades,
    ] = await Promise.all([
      adapter.getProfile(),
      adapter.getMargins(),
      adapter.getHoldings(),
      adapter.getPositions(),
      adapter.getOrders(),
      adapter.getTrades(),
    ]);

    return {
      profile,
      margins,
      holdings,
      positions,
      orders,
      trades,
      health: {
        connected: true,
        lastSync: new Date(),
      },
    };
  }
}