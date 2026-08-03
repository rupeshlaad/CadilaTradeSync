import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from './zerodha/zerodha.adapter';
import {
  Broker,
  BrokerSession,
  ConnectionStatus,
  TradingAccount,
} from '@prisma/client';

interface ZerodhaAdapterContext {
  adapter: ZerodhaAdapter;
  account: TradingAccount;
  session: BrokerSession;
}

interface SettledSection<T> {
  data: T | null;
  error: string | null;
}

function settle<T>(r: PromiseSettledResult<T>): SettledSection<T> {
  if (r.status === 'fulfilled') {
    return { data: r.value, error: null };
  }
  const reason: any = r.reason;
  const msg =
    (reason && (reason.message || reason.error_type || reason.toString?.())) ||
    'Unknown error';
  return { data: null, error: String(msg) };
}

/**
 * Heuristic: does this rejection look like an auth/token failure
 * (as opposed to a broker-availability / network failure)?
 * Kite typically raises `TokenException` with a message that includes
 * "Incorrect `api_key` or `access_token`" or "Token is invalid or has expired".
 */
function isTokenError(err: any): boolean {
  if (!err) return false;
  const type = err.error_type ?? err.name ?? '';
  if (typeof type === 'string' && /token/i.test(type)) return true;
  const msg = String(err.message ?? err.toString?.() ?? '');
  return /token.*(invalid|expired)|(invalid|expired).*token|api_key/i.test(msg);
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

  /**
   * Compute session/connection health without hitting the broker.
   * Safe to call from a "Refresh Status" button.
   */
  async getSessionHealth(accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
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

    const now = Date.now();
    const tokenExpired = session?.expiresAt
      ? session.expiresAt.getTime() < now
      : null;
    const sessionActive =
      !!session && account.connectionStatus === ConnectionStatus.CONNECTED && tokenExpired !== true;

    let connectionStatus: ConnectionStatus = account.connectionStatus;
    if (!session) connectionStatus = ConnectionStatus.DISCONNECTED;
    else if (tokenExpired === true) connectionStatus = ConnectionStatus.EXPIRED;

    // If the persisted status drifted from the observed one, correct it.
    if (connectionStatus !== account.connectionStatus) {
      await this.prisma.tradingAccount.update({
        where: { id: accountId },
        data: { connectionStatus },
      });
    }

    return {
      broker: session?.broker ?? account.broker,
      connectionStatus,
      loginTime: session ? session.loginTime.toISOString() : null,
      lastHeartbeat: account.lastHeartbeat
        ? account.lastHeartbeat.toISOString()
        : null,
      sessionActive,
      tokenExpired,
    };
  }

  /**
   * Disconnect the broker for a trading account:
   *  - delete broker session(s)
   *  - set TradingAccount.connectionStatus = DISCONNECTED
   *  - clear lastHeartbeat
   *  - keep the TradingAccount itself intact
   */
  async disconnect(accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException('Trading account not found');
    }

    // deleteMany is idempotent — safe if the session is already gone.
    // Scoping to the account's current broker is enough for now; the schema
    // only allows one session per (account, broker) pair.
    await this.prisma.brokerSession.deleteMany({
      where: { tradingAccountId: accountId },
    });

    const updated = await this.prisma.tradingAccount.update({
      where: { id: accountId },
      data: {
        connectionStatus: ConnectionStatus.DISCONNECTED,
        lastHeartbeat: null,
      },
    });

    return {
      ok: true,
      broker: account.broker,
      connectionStatus: updated.connectionStatus,
    };
  }

  async getDashboard(accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
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

    const emptyErrors = {
      profile: null as string | null,
      margins: null as string | null,
      holdings: null as string | null,
      positions: null as string | null,
      orders: null as string | null,
      trades: null as string | null,
    };

    // ----- No session: return a well-formed, disconnected response -----
    if (!session) {
      if (account.connectionStatus !== ConnectionStatus.DISCONNECTED) {
        await this.prisma.tradingAccount.update({
          where: { id: accountId },
          data: {
            connectionStatus: ConnectionStatus.DISCONNECTED,
            lastHeartbeat: null,
          },
        });
      }
      return {
        profile: null,
        margins: null,
        holdings: null,
        positions: null,
        orders: null,
        trades: null,
        errors: {
          ...emptyErrors,
          profile: 'No active broker session. Please connect the broker.',
        },
        health: {
          connected: false,
          connectionStatus: ConnectionStatus.DISCONNECTED,
          broker: account.broker,
          loginTime: null,
          lastHeartbeat: account.lastHeartbeat
            ? account.lastHeartbeat.toISOString()
            : null,
          sessionActive: false,
          tokenExpired: null,
        },
      };
    }

    // ----- Session present: hit the broker -----
    const adapter = new ZerodhaAdapter();
    adapter.setAccessToken(
      this.encryption.decrypt(session.encryptedAccessToken),
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

    const results = [profileR, marginsR, holdingsR, positionsR, ordersR, tradesR];
    const allRejected = results.every((r) => r.status === 'rejected');
    const anyTokenError = results.some(
      (r) => r.status === 'rejected' && isTokenError((r as PromiseRejectedResult).reason),
    );

    // Profile is the cheapest authenticated probe; use it as the liveness signal.
    const connected = profile.data !== null;

    let liveStatus: ConnectionStatus;
    if (connected) {
      liveStatus = ConnectionStatus.CONNECTED;
    } else if (anyTokenError) {
      liveStatus = ConnectionStatus.EXPIRED;
    } else if (allRejected) {
      liveStatus = ConnectionStatus.ERROR;
    } else {
      // Partial: profile failed but other calls succeeded — treat as ERROR on account
      // level but still return the data we did get.
      liveStatus = ConnectionStatus.ERROR;
    }

    // Persist heartbeat + status in a single query (no duplicate reads/writes).
    const updated = await this.prisma.tradingAccount.update({
      where: { id: accountId },
      data: {
        connectionStatus: liveStatus,
        ...(connected ? { lastHeartbeat: new Date() } : {}),
      },
    });

    const nowMs = Date.now();
    const tokenExpiredByClock = session.expiresAt
      ? session.expiresAt.getTime() < nowMs
      : null;
    const tokenExpired =
      liveStatus === ConnectionStatus.EXPIRED ? true : tokenExpiredByClock;
    const sessionActive = connected && tokenExpired !== true;

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
        connectionStatus: liveStatus,
        broker: session.broker,
        loginTime: session.loginTime.toISOString(),
        lastHeartbeat: updated.lastHeartbeat
          ? updated.lastHeartbeat.toISOString()
          : null,
        sessionActive,
        tokenExpired,
      },
    };
  }
}
