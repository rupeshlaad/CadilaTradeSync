import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from './zerodha/zerodha.adapter';
import { Broker, BrokerSession, TradingAccount } from '@prisma/client';

interface ZerodhaAdapterContext {
  adapter: ZerodhaAdapter;
  account: TradingAccount;
  session: BrokerSession;
}

function settle<T>(
  r: PromiseSettledResult<T>,
): { data: T | null; error: string | null } {
  if (r.status === 'fulfilled') {
    return { data: r.value, error: null };
  }
  const reason: any = r.reason;
  const msg =
    (reason && (reason.message || reason.error_type || reason.toString?.())) ||
    'Unknown error';
  return { data: null, error: String(msg) };
}

@Injectable()
export class BrokerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private async getZerodhaAdapter(
    accountId: string,
  ): Promise<ZerodhaAdapterContext> {
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
      this.encryption.decrypt(session.encryptedAccessToken),
    );

    return { adapter, account, session };
  }

  async getDashboard(accountId: string) {
    const { adapter, account, session } = await this.getZerodhaAdapter(
      accountId,
    );

    const [
      profileR,
      marginsR,
      holdingsR,
      positionsR,
      ordersR,
      tradesR,
    ] = await Promise.allSettled([
      adapter.getProfile(),
      adapter.getMargins(),
      adapter.getHoldings(),
      adapter.getPositions(),
      adapter.getOrders(),
      adapter.getTrades(),
    ]);

    const profile = settle(profileR);
    const margins = settle(marginsR);
    const holdings = settle(holdingsR);
    const positions = settle(positionsR);
    const orders = settle(ordersR);
    const trades = settle(tradesR);

    // Live-checked connectivity: profile call is the cheapest authenticated probe.
    const connected = profile.data !== null;

    return {
      profile: profile.data,
      margins: margins.data,
      holdings: holdings.data,
      positions: positions.data,
      orders: orders.data,
      trades: trades.data,
      errors: {
        profile: profile.error,
        margins: margins.error,
        holdings: holdings.error,
        positions: positions.error,
        orders: orders.error,
        trades: trades.error,
      },
      health: {
        connected,
        connectionStatus: account.connectionStatus,
        lastHeartbeat: account.lastHeartbeat
          ? account.lastHeartbeat.toISOString()
          : null,
        loginTime: session.loginTime.toISOString(),
      },
    };
  }
}
