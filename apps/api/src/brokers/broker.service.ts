import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from './zerodha/zerodha.adapter';
import { FyersAdapter } from './fyers/fyers.adapter';
import { ShoonyaAdapter } from './shoonya/shoonya.adapter';
import { Broker, BrokerSession, ConnectionStatus, TradingAccount } from '@prisma/client';
import type { BrokerCapabilities } from './broker.interface';

/**
 * Sprint 6.1.2 — Follower Broker Lifecycle Stabilization.
 *
 * This service is the single broker-session engine shared by the Master
 * (admin) portal and the Follower (web) portal. Previously every lookup was
 * hardcoded to ZERODHA, which meant a Fyers/Shoonya session could never be
 * found — the drift-correction then wrote DISCONNECTED back to the account
 * on every refresh, which is exactly the "connection not persistent" bug.
 *
 * All lookups are now broker-aware (driven by `TradingAccount.broker`) and
 * the correct adapter is selected per broker. Connection state always comes
 * from the persisted TradingAccount + BrokerSession rows — never fabricated.
 */

type AnyAdapter = ZerodhaAdapter | FyersAdapter | ShoonyaAdapter;

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
 */
function isTokenError(err: any): boolean {
  if (!err) return false;
  const type = err.error_type ?? err.name ?? '';
  if (typeof type === 'string' && /token/i.test(type)) return true;
  const msg = String(err.message ?? err.toString?.() ?? '');
  return /token.*(invalid|expired)|(invalid|expired).*token|api_key/i.test(msg);
}

type SessionHealthState =
  | 'CONNECTED'
  | 'EXPIRED'
  | 'INVALID_TOKEN'
  | 'REAUTHENTICATION_REQUIRED'
  | 'NEVER_CONNECTED'
  | 'DISCONNECTED';

type TokenStatus = 'VALID' | 'EXPIRED' | 'INVALID' | 'NONE';

@Injectable()
export class BrokerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  // -------------------------------------------------------------------------
  // Shared lookup + adapter selection
  // -------------------------------------------------------------------------

  private async loadContext(accountId: string): Promise<{
    account: TradingAccount;
    session: BrokerSession | null;
  }> {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException('Trading account not found');
    }
    // Broker-aware: use the account's own broker (not a hardcoded ZERODHA).
    const session = await this.prisma.brokerSession.findUnique({
      where: {
        tradingAccountId_broker: {
          tradingAccountId: accountId,
          broker: account.broker,
        },
      },
    });
    return { account, session };
  }

  private buildAdapter(broker: Broker, accessToken: string): AnyAdapter {
    switch (broker) {
      case Broker.FYERS: {
        const adapter = new FyersAdapter();
        adapter.setAccessToken(accessToken);
        return adapter;
      }
      case Broker.SHOONYA: {
        const adapter = new ShoonyaAdapter();
        adapter.setSessionToken(accessToken);
        return adapter;
      }
      case Broker.ZERODHA:
      default: {
        const adapter = new ZerodhaAdapter();
        adapter.setAccessToken(accessToken);
        return adapter;
      }
    }
  }

  /**
   * Sprint 6.1.3 — Static broker-data capabilities, read straight from the
   * adapter classes (no instantiation → no env dependency). The single place
   * every module (broker cards today; Holdings / Positions / Orders / Trades /
   * Portfolio / Live P&L tomorrow) can ask "does this broker expose X?".
   */
  capabilitiesFor(broker: Broker): BrokerCapabilities {
    switch (broker) {
      case Broker.FYERS:
        return FyersAdapter.capabilities;
      case Broker.SHOONYA:
        return ShoonyaAdapter.capabilities;
      case Broker.ZERODHA:
        return ZerodhaAdapter.capabilities;
      default:
        // Unknown brokers advertise nothing until an adapter is wired.
        return {
          profile: false,
          exchanges: false,
          products: false,
          funds: false,
          margin: false,
          holdings: false,
          positions: false,
          orders: false,
          trades: false,
        };
    }
  }

  /**
   * Invoke an optional adapter method safely. Fyers/Shoonya adapters do not
   * implement every method (e.g. `getTrades`), which would otherwise throw a
   * synchronous TypeError and escape Promise.allSettled. Returns a rejected
   * promise for unsupported capabilities so the section renders "—" instead
   * of crashing the whole dashboard.
   */
  private safeCall(adapter: any, method: string): Promise<any> {
    const fn = adapter?.[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`${method} not supported by broker`));
    }
    try {
      return Promise.resolve(fn.call(adapter));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private deriveTokenStatus(
    session: BrokerSession | null,
    tokenExpired: boolean | null,
    status: ConnectionStatus,
  ): TokenStatus {
    if (!session) return 'NONE';
    if (tokenExpired === true || status === ConnectionStatus.EXPIRED) {
      return 'EXPIRED';
    }
    if (status === ConnectionStatus.ERROR) return 'INVALID';
    return 'VALID';
  }

  private deriveHealthState(
    account: TradingAccount,
    session: BrokerSession | null,
    status: ConnectionStatus,
    tokenExpired: boolean | null,
  ): SessionHealthState {
    if (!session) {
      // No session and the account has never produced a heartbeat → the
      // broker was never connected. Otherwise it was disconnected.
      if (status === ConnectionStatus.DISCONNECTED && !account.lastHeartbeat) {
        return 'NEVER_CONNECTED';
      }
      return 'DISCONNECTED';
    }
    if (tokenExpired === true || status === ConnectionStatus.EXPIRED) {
      return 'EXPIRED';
    }
    if (status === ConnectionStatus.ERROR) return 'REAUTHENTICATION_REQUIRED';
    if (status === ConnectionStatus.CONNECTED) return 'CONNECTED';
    return 'DISCONNECTED';
  }

  /**
   * Extract a normalized funds/margin snapshot from a broker margins payload.
   * Values are read straight from the broker response — never fabricated.
   * Returns null when the broker does not expose margins.
   */
  private normalizeFunds(margins: any):
    | Array<{
        segment: string;
        available: number | null;
        used: number | null;
        net: number | null;
      }>
    | null {
    if (!margins || typeof margins !== 'object') return null;
    const toNum = (v: any): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const out: Array<{
      segment: string;
      available: number | null;
      used: number | null;
      net: number | null;
    }> = [];
    for (const key of Object.keys(margins)) {
      const row = margins[key];
      if (!row || typeof row !== 'object') continue;
      const available =
        row?.available?.live_balance ??
        row?.available?.cash ??
        row?.net ??
        row?.available;
      const used =
        row?.utilised?.debits ?? row?.utilised?.total ?? row?.used ?? row?.utilised;
      const net = row?.net ?? row?.available?.live_balance;
      out.push({
        segment: key,
        available: toNum(available),
        used: toNum(used),
        net: toNum(net),
      });
    }
    return out.length > 0 ? out : null;
  }

  // -------------------------------------------------------------------------
  // Session health (cheap, clock-based — no broker round-trip)
  // -------------------------------------------------------------------------

  async getSessionHealth(accountId: string) {
    const { account, session } = await this.loadContext(accountId);

    const now = Date.now();
    const tokenExpired = session?.expiresAt
      ? session.expiresAt.getTime() < now
      : null;

    let connectionStatus: ConnectionStatus = account.connectionStatus;
    if (!session) connectionStatus = ConnectionStatus.DISCONNECTED;
    else if (tokenExpired === true) connectionStatus = ConnectionStatus.EXPIRED;

    // Correct persisted drift only when we can prove it from persisted state
    // (missing session, or a clock-expired token). We never downgrade a
    // CONNECTED account just because a cheap probe cannot reach the broker.
    if (connectionStatus !== account.connectionStatus) {
      await this.prisma.tradingAccount.update({
        where: { id: accountId },
        data: { connectionStatus },
      });
    }

    const sessionActive =
      !!session &&
      connectionStatus === ConnectionStatus.CONNECTED &&
      tokenExpired !== true;

    const loginTime = session ? session.loginTime.toISOString() : null;

    return {
      broker: session?.broker ?? account.broker,
      clientId: account.clientId,
      accountHolder: session?.userName ?? null,
      brokerUserId: session?.userId ?? null,
      connectionStatus,
      sessionHealthState: this.deriveHealthState(
        account,
        session,
        connectionStatus,
        tokenExpired,
      ),
      tokenStatus: this.deriveTokenStatus(session, tokenExpired, connectionStatus),
      loginTime,
      connectionTime: loginTime,
      lastHeartbeat: account.lastHeartbeat
        ? account.lastHeartbeat.toISOString()
        : null,
      expiresAt: session?.expiresAt ? session.expiresAt.toISOString() : null,
      sessionActive,
      tokenExpired,
    };
  }

  // -------------------------------------------------------------------------
  // Disconnect — invalidate session, preserve the account & history
  // -------------------------------------------------------------------------

  async disconnect(accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException('Trading account not found');
    }

    // Broker-agnostic + idempotent: removes the token so reconnect is required,
    // while the TradingAccount (and all historical records) are preserved.
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

  // -------------------------------------------------------------------------
  // Live dashboard / verify — actual broker validation via the adapter
  // -------------------------------------------------------------------------

  async getDashboard(accountId: string) {
    const { account, session } = await this.loadContext(accountId);

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
        funds: null,
        errors: {
          ...emptyErrors,
          profile: 'No active broker session. Please connect the broker.',
        },
        health: {
          connected: false,
          connectionStatus: ConnectionStatus.DISCONNECTED,
          sessionHealthState: this.deriveHealthState(
            account,
            null,
            ConnectionStatus.DISCONNECTED,
            null,
          ),
          tokenStatus: 'NONE' as TokenStatus,
          broker: account.broker,
          clientId: account.clientId,
          accountHolder: null,
          brokerUserId: null,
          loginTime: null,
          lastHeartbeat: account.lastHeartbeat
            ? account.lastHeartbeat.toISOString()
            : null,
          sessionActive: false,
          tokenExpired: null,
        },
      };
    }

    // ----- Session present: hit the broker with the correct adapter -----
    const adapter = this.buildAdapter(
      account.broker,
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
      this.safeCall(adapter, 'getProfile'),
      this.safeCall(adapter, 'getMargins'),
      this.safeCall(adapter, 'getHoldings'),
      this.safeCall(adapter, 'getPositions'),
      this.safeCall(adapter, 'getOrders'),
      this.safeCall(adapter, 'getTrades'),
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
      (r) =>
        r.status === 'rejected' &&
        isTokenError((r as PromiseRejectedResult).reason),
    );

    // Profile is the cheapest authenticated probe; use it as the liveness signal.
    const connected = profile.data !== null;

    let liveStatus: ConnectionStatus;
    if (connected) {
      liveStatus = ConnectionStatus.CONNECTED;
    } else if (anyTokenError) {
      liveStatus = ConnectionStatus.EXPIRED;
    } else {
      liveStatus = ConnectionStatus.ERROR;
    }

    // Persist heartbeat + status in a single query.
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

    // Live health state: distinguish an explicit token rejection ("invalid
    // token") from a general broker/network error ("reauthentication required").
    let liveHealthState: SessionHealthState;
    if (connected) liveHealthState = 'CONNECTED';
    else if (anyTokenError) liveHealthState = 'INVALID_TOKEN';
    else if (allRejected) liveHealthState = 'REAUTHENTICATION_REQUIRED';
    else liveHealthState = 'REAUTHENTICATION_REQUIRED';

    const tokenStatus: TokenStatus = connected
      ? 'VALID'
      : anyTokenError
      ? 'INVALID'
      : 'EXPIRED';

    const profileData: any = profile.data;

    return {
      profile: profile.data,
      margins: margins.data,
      holdings: holdings.data,
      positions: positions.data,
      orders: orders.data,
      trades: trades.data,
      funds: this.normalizeFunds(margins.data),
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
        sessionHealthState: liveHealthState,
        tokenStatus,
        broker: session.broker,
        clientId: account.clientId,
        accountHolder: profileData?.userName ?? session.userName ?? null,
        brokerUserId: profileData?.userId ?? session.userId ?? null,
        loginTime: session.loginTime.toISOString(),
        lastHeartbeat: updated.lastHeartbeat
          ? updated.lastHeartbeat.toISOString()
          : null,
        sessionActive,
        tokenExpired,
      },
    };
  }

  /**
   * Sprint 6.1.2 / 6.1.3 — Compact broker-account verification used by the
   * Follower Broker Accounts cards. Reuses the same live adapter probe as
   * getDashboard() (Master/Follower parity — one backend service) and layers
   * the broker's declared capabilities on top so the UI can render
   * "Not Supported by Broker" instead of a fabricated/empty value.
   */
  async getBrokerInfo(accountId: string) {
    const { account } = await this.loadContext(accountId);
    const capabilities = this.capabilitiesFor(account.broker);

    const dash = await this.getDashboard(accountId);
    const profile: any = dash.profile;
    const health: any = dash.health;

    const profileOk = dash.errors.profile === null && profile !== null;
    const marginOk = dash.errors.margins === null && dash.margins !== null;

    // Only surface a value when the broker supports it AND the probe returned
    // data. Everything else is left null so the UI can decide between
    // "Not Supported by Broker" (capability = false) and "—" (no data yet).
    const exchanges =
      capabilities.exchanges && Array.isArray(profile?.exchanges)
        ? profile.exchanges
        : null;
    const products =
      capabilities.products && Array.isArray(profile?.products)
        ? profile.products
        : null;
    const funds = capabilities.funds ? dash.funds : null;

    return {
      broker: health.broker,
      clientId: health.clientId,
      accountHolder: health.accountHolder,
      brokerUserId: health.brokerUserId,
      email: profile?.email ?? null,
      connectionStatus: health.connectionStatus,
      sessionHealthState: health.sessionHealthState,
      tokenStatus: health.tokenStatus,
      loginTime: health.loginTime,
      connectionTime: health.loginTime,
      lastSync: health.lastHeartbeat,
      capabilities,
      profileAvailable: profileOk,
      exchanges,
      products,
      funds,
      marginAvailable: capabilities.margin && marginOk,
      error: dash.errors.profile,
    };
  }
}
