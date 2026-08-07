import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { ZerodhaAdapter } from './zerodha/zerodha.adapter';
import { FyersAdapter } from './fyers/fyers.adapter';
import { ShoonyaAdapter } from './shoonya/shoonya.adapter';
import { ICICIDirectAdapter } from './icici/icici.adapter';
import { Broker, BrokerSession, ConnectionStatus, TradingAccount } from '@prisma/client';
import type {
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
} from './broker.interface';

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

type AnyAdapter =
  | ZerodhaAdapter
  | FyersAdapter
  | ShoonyaAdapter
  | ICICIDirectAdapter;

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

  private buildAdapter(
    broker: Broker,
    accessToken: string,
    userId?: string,
    creds?: { apiKey?: string; apiSecret?: string },
  ): AnyAdapter {
    switch (broker) {
      case Broker.FYERS: {
        const adapter = new FyersAdapter();
        adapter.setAccessToken(accessToken);
        return adapter;
      }
      case Broker.SHOONYA: {
        const adapter = new ShoonyaAdapter();
        adapter.setSessionToken(accessToken);
        // Sprint 6.1.6 — Noren data endpoints require uid/actid.
        if (userId) adapter.setUserId(userId);
        return adapter;
      }
      case Broker.ICICI_DIRECT: {
        // Sprint 6.2.0 — Breeze keys are per-account (not env-based). The raw
        // API session token is stored as the access token; api key + secret
        // are needed for the per-request checksum headers.
        const adapter = new ICICIDirectAdapter();
        adapter.setCredentials(creds?.apiKey ?? '', creds?.apiSecret ?? '');
        adapter.setSessionToken(accessToken);
        if (userId) adapter.setUserId(userId);
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
   * Sprint 6.2.0 — ICICI Direct needs the account's api key + secret (for the
   * Breeze checksum headers) in addition to the session token. Returns
   * undefined for every other broker so their adapter construction is
   * unchanged.
   */
  private iciciCreds(
    account: TradingAccount,
  ): { apiKey?: string; apiSecret?: string } | undefined {
    if (account.broker !== Broker.ICICI_DIRECT) return undefined;
    return {
      apiKey: account.encryptedApiKey
        ? this.encryption.decrypt(account.encryptedApiKey)
        : undefined,
      apiSecret: account.encryptedApiSecret
        ? this.encryption.decrypt(account.encryptedApiSecret)
        : undefined,
    };
  }

  /**
   * Sprint 6.2.8 — Broker-aware adapter factory for a trading account.
   *
   * The single place any polling/execution engine (e.g. MasterWatcherService)
   * obtains a live, credentialed adapter for an account's OWN broker. This
   * replaces the previously hardcoded `new ZerodhaAdapter()` in the master
   * watcher, which meant ICICI / Fyers / Shoonya masters were never polled.
   *
   * Returns null when the account has no persisted broker session (nothing to
   * poll). ICICI receives its api key/secret + session token; Shoonya receives
   * its uid; Zerodha/Fyers receive the access token — identical wiring to the
   * dashboard path in `loadContext` + `buildAdapter`.
   */
  async getAdapterForAccount(
    accountId: string,
  ): Promise<{ broker: Broker; adapter: AnyAdapter } | null> {
    const { account, session } = await this.loadContext(accountId);
    if (!session) return null;
    const accessToken = this.encryption.decrypt(session.encryptedAccessToken);
    const adapter = this.buildAdapter(
      account.broker,
      accessToken,
      session.userId ?? account.clientId,
      this.iciciCreds(account),
    );
    return { broker: account.broker, adapter };
  }

  /**
   * Normalize the various broker `getOrders()` envelopes into a flat array.
   * Zerodha → array; Fyers → { orderBook | data }; Shoonya → array; ICICI →
   * the Breeze `Success` block (array or single object). Sprint 6.2.8.
   */
  static toOrderArray(orders: any): any[] {
    if (!orders) return [];
    if (Array.isArray(orders)) return orders;
    if (Array.isArray(orders.orderBook)) return orders.orderBook;
    if (Array.isArray(orders.data)) return orders.data;
    if (Array.isArray(orders.Success)) return orders.Success;
    if (typeof orders === 'object') return [orders];
    return [];
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
      case Broker.ICICI_DIRECT:
        return ICICIDirectAdapter.capabilities;
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
   * Broker-aware (Zerodha / Fyers / Shoonya envelopes differ) but values are
   * read straight from the broker response — never fabricated. Returns null
   * when the broker did not return usable margins.
   */
  private normalizeFunds(broker: Broker, margins: any) {
    if (broker === Broker.FYERS) return this.normalizeFyersFunds(margins);
    if (broker === Broker.SHOONYA) return this.normalizeShoonyaFunds(margins);
    if (broker === Broker.ICICI_DIRECT) return this.normalizeICICIFunds(margins);
    return this.normalizeZerodhaFunds(margins);
  }

  private normalizeICICIFunds(margins: any) {
    // Breeze `funds` Success → { total_bank_balance, unallocated_balance,
    // allocated_equity, allocated_fno, block_by_trade_balance, ... }.
    if (!margins || typeof margins !== 'object') return null;
    const availableCash = this.num(margins.total_bank_balance);
    const unallocated = this.num(margins.unallocated_balance);
    const used = this.num(
      margins.block_by_trade_balance ??
        margins.block_by_trade_equity ??
        margins.block_by_trade_fno,
    );
    const availableMargin = unallocated ?? availableCash;
    if (availableCash === null && unallocated === null && used === null) {
      return null;
    }
    return [
      this.fund('EQUITY', {
        availableCash,
        usedMargin: used,
        availableMargin,
        net: availableMargin,
      }),
    ];
  }

  private fund(
    segment: string,
    v: Partial<{
      availableCash: any;
      usedMargin: any;
      availableMargin: any;
      openingBalance: any;
      collateral: any;
      net: any;
    }>,
  ) {
    const availableMargin = this.num(v.availableMargin);
    const net = this.num(v.net) ?? availableMargin;
    return {
      segment,
      available: availableMargin ?? this.num(v.availableCash) ?? net,
      used: this.num(v.usedMargin),
      net,
      availableCash: this.num(v.availableCash),
      usedMargin: this.num(v.usedMargin),
      availableMargin,
      openingBalance: this.num(v.openingBalance),
      collateral: this.num(v.collateral),
    };
  }

  private normalizeZerodhaFunds(margins: any) {
    if (!margins || typeof margins !== 'object') return null;
    const out: ReturnType<BrokerService['fund']>[] = [];
    for (const key of Object.keys(margins)) {
      const row = margins[key];
      if (!row || typeof row !== 'object') continue;
      out.push(
        this.fund(key, {
          availableCash: row?.available?.cash,
          openingBalance: row?.available?.opening_balance,
          collateral: row?.available?.collateral,
          availableMargin: row?.available?.live_balance ?? row?.net,
          usedMargin: row?.utilised?.debits ?? row?.utilised?.total,
          net: row?.net,
        }),
      );
    }
    return out.length > 0 ? out : null;
  }

  private normalizeFyersFunds(margins: any) {
    // Fyers get_funds → { fund_limit: [{ id, title, equityAmount, commodityAmount }] }
    const list = Array.isArray(margins?.fund_limit) ? margins.fund_limit : null;
    if (!list) return null;
    const byTitle = (t: RegExp) =>
      list.find((r: any) => t.test(String(r?.title ?? '')))?.equityAmount;
    return [
      this.fund('EQUITY', {
        availableCash: byTitle(/available balance|cash/i),
        usedMargin: byTitle(/utili[sz]ed/i),
        availableMargin: byTitle(/available balance/i),
        openingBalance: byTitle(/opening/i),
        collateral: byTitle(/collateral/i),
        net: byTitle(/available balance/i),
      }),
    ];
  }

  private normalizeShoonyaFunds(margins: any) {
    // Shoonya Limits → { cash, marginused, payin, brkcollamt, ... }
    if (!margins || typeof margins !== 'object') return null;
    const cash = this.num(margins.cash);
    const used = this.num(margins.marginused);
    const collateral = this.num(margins.brkcollamt) ?? this.num(margins.collateral);
    if (cash === null && used === null && collateral === null) return null;
    const availableMargin =
      cash !== null || used !== null ? (cash ?? 0) - (used ?? 0) : null;
    return [
      this.fund('EQUITY', {
        availableCash: cash,
        usedMargin: used,
        availableMargin,
        openingBalance: margins.payin,
        collateral,
        net: availableMargin,
      }),
    ];
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

    // Sprint 6.1.5 — disconnecting from CTS also disables copy trading for
    // every follower link that trades through this account. Broker
    // authorization at the broker itself is NOT touched (no SDK logout).
    await this.prisma.follower.updateMany({
      where: { tradingAccountId: accountId },
      data: { enabled: false },
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
      copyTradingDisabled: true,
      message:
        'Broker authorization remains active. Only CTS connection has been removed.',
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
      session.userId ?? account.clientId,
      this.iciciCreds(account),
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
      funds: this.normalizeFunds(account.broker, margins.data),
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

    // Sprint 6.1.4 — live profile (only fields the SDK actually returned).
    // Missing fields stay null → UI shows "Not provided by broker".
    const liveProfile = {
      userName: profile?.userName ?? null,
      email: profile?.email ?? null,
      mobile: profile?.mobile ?? null,
      accountType: profile?.accountType ?? null,
      rmsStatus: profile?.rmsStatus ?? null,
      exchanges: capabilities.exchanges && Array.isArray(profile?.exchanges)
        ? profile.exchanges
        : null,
      products: capabilities.products && Array.isArray(profile?.products)
        ? profile.products
        : null,
      segments: Array.isArray(profile?.segments) ? profile.segments : null,
      profileStatus: profile?.profileStatus ?? (profileOk ? 'ACTIVE' : null),
    };

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
      liveProfile,
      exchanges,
      products,
      funds,
      marginAvailable: capabilities.margin && marginOk,
      error: dash.errors.profile,
    };
  }

  // -------------------------------------------------------------------------
  // Sprint 6.1.5 — Feature / onboarding metadata (capability-driven UI)
  // -------------------------------------------------------------------------

  featuresFor(broker: Broker): BrokerFeatureSupport {
    switch (broker) {
      case Broker.FYERS:
        return FyersAdapter.features;
      case Broker.SHOONYA:
        return ShoonyaAdapter.features;
      case Broker.ICICI_DIRECT:
        return ICICIDirectAdapter.features;
      case Broker.ZERODHA:
        return ZerodhaAdapter.features;
      default:
        return {
          supportsProfile: false,
          supportsFunds: false,
          supportsMargins: false,
          supportsHoldings: false,
          supportsPositions: false,
          supportsOrders: false,
          supportsTrades: false,
          supportsPortfolio: false,
          supportsAutoLogin: false,
          supportsLogout: false,
          supportsSessionRefresh: false,
        };
    }
  }

  onboardingFor(broker: Broker): BrokerOnboardingRequirements {
    switch (broker) {
      case Broker.FYERS:
        return FyersAdapter.onboarding;
      case Broker.SHOONYA:
        return ShoonyaAdapter.onboarding;
      case Broker.ICICI_DIRECT:
        return ICICIDirectAdapter.onboarding;
      case Broker.ZERODHA:
        return ZerodhaAdapter.onboarding;
      default:
        return {
          requiresOAuth: false,
          requiresApiKey: false,
          requiresSecret: false,
          requiresPassword: false,
          requiresPIN: false,
          requiresTOTP: false,
          requiresStaticIP: false,
          requiresRedirect: false,
          requiresVendorCode: false,
          supportsAutoLogin: false,
          supportsTokenRefresh: false,
          supportsMFA: false,
        };
    }
  }

  /** Static broker catalog for the dynamic onboarding form + capability UI. */
  brokerCatalog() {
    return (Object.values(Broker) as Broker[]).map((broker) => ({
      broker,
      capabilities: this.capabilitiesFor(broker),
      features: this.featuresFor(broker),
      onboarding: this.onboardingFor(broker),
    }));
  }

  // -------------------------------------------------------------------------
  // Sprint 6.1.5 — SDK-driven normalization (values read straight from broker)
  // -------------------------------------------------------------------------

  private num(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Pull the row array out of each broker's envelope (broker-aware). */
  private toArray(broker: Broker, raw: any, keys: string[]): any[] | null {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      for (const k of keys) {
        if (Array.isArray(raw[k])) return raw[k];
      }
    }
    return null;
  }

  private normalizeHoldings(broker: Broker, raw: any) {
    const list = this.toArray(broker, raw, ['holdings']);
    if (!list) return null;
    return list.map((h: any) => {
      if (broker === Broker.FYERS) {
        const qty = this.num(h?.quantity ?? h?.remainingQuantity);
        return {
          symbol: h?.symbol ?? '—',
          exchange: h?.exchange != null ? String(h.exchange) : null,
          quantity: qty,
          averagePrice: this.num(h?.costPrice),
          ltp: this.num(h?.ltp),
          currentValue: this.num(h?.marketVal),
          pnl: this.num(h?.pl),
        };
      }
      if (broker === Broker.SHOONYA) {
        const t = Array.isArray(h?.exch_tsym) ? h.exch_tsym[0] : {};
        const qty = this.num(h?.holdqty ?? h?.npoadqty ?? h?.dpqty);
        return {
          symbol: t?.tsym ?? '—',
          exchange: t?.exch ?? null,
          quantity: qty,
          averagePrice: this.num(h?.upldprc),
          ltp: null, // Shoonya holdings do not carry LTP; requires a quote call.
          currentValue: null,
          pnl: null,
        };
      }
      if (broker === Broker.ICICI_DIRECT) {
        // Breeze portfolioholdings → { stock_code, exchange_code, quantity,
        // average_price, current_market_price }. LTP is the holdings-provided
        // current_market_price, else the quotes-enriched `ltp` (set by the
        // adapter). Value/P&L are derived — never fabricated.
        const qty = this.num(
          h?.quantity ?? h?.demat_avail_quantity ?? h?.demat_total_bulk_quantity,
        );
        const avg = this.num(
          h?.average_price ?? h?.average_cost_of_holdings ?? h?.average_cost,
        );
        const ltp = this.num(h?.ltp ?? h?.current_market_price ?? h?.market_price);
        const currentValue =
          qty !== null && ltp !== null ? Number((qty * ltp).toFixed(2)) : null;
        const pnl =
          qty !== null && ltp !== null && avg !== null
            ? Number(((ltp - avg) * qty).toFixed(2))
            : null;
        return {
          symbol: h?.stock_code ?? h?.stock_ISIN ?? '—',
          exchange: h?.exchange_code ?? null,
          quantity: qty,
          averagePrice: avg,
          ltp,
          currentValue,
          pnl,
        };
      }
      const qty = this.num(h?.quantity ?? h?.opening_quantity);
      const ltp = this.num(h?.last_price);
      return {
        symbol: h?.tradingsymbol ?? h?.symbol ?? '—',
        exchange: h?.exchange ?? null,
        quantity: qty,
        averagePrice: this.num(h?.average_price),
        ltp,
        currentValue:
          qty !== null && ltp !== null ? Number((qty * ltp).toFixed(2)) : null,
        pnl: this.num(h?.pnl),
      };
    });
  }

  private normalizePositions(broker: Broker, raw: any) {
    const list = this.toArray(broker, raw, ['net', 'netPositions']);
    if (!list) return null;
    return list.map((p: any) => {
      if (broker === Broker.FYERS) {
        return {
          symbol: p?.symbol ?? '—',
          exchange: p?.exchange != null ? String(p.exchange) : null,
          product: p?.productType ?? null,
          quantity: this.num(p?.netQty),
          averagePrice: this.num(p?.netAvg ?? p?.avgPrice),
          ltp: this.num(p?.ltp),
          pnl: this.num(p?.pl),
        };
      }
      if (broker === Broker.SHOONYA) {
        return {
          symbol: p?.tsym ?? '—',
          exchange: p?.exch ?? null,
          product: p?.prd ?? null,
          quantity: this.num(p?.netqty),
          averagePrice: this.num(p?.netavgprc ?? p?.daybuyavgprc),
          ltp: this.num(p?.lp),
          pnl: this.num(p?.rpnl ?? p?.urmtom),
        };
      }
      if (broker === Broker.ICICI_DIRECT) {
        // Breeze portfoliopositions → { stock_code, exchange_code,
        // product_type, quantity, average_price, ltp }. Use the API-provided
        // P&L when present, else derive from the quotes-enriched LTP.
        const qty = this.num(p?.quantity);
        const avg = this.num(p?.average_price);
        const ltp = this.num(p?.ltp ?? p?.current_market_price ?? p?.last_traded_price);
        const pnl =
          this.num(p?.pnl) ??
          (qty !== null && ltp !== null && avg !== null
            ? Number(((ltp - avg) * qty).toFixed(2))
            : null);
        return {
          symbol: p?.stock_code ?? '—',
          exchange: p?.exchange_code ?? null,
          product: p?.product_type ?? p?.product ?? null,
          quantity: qty,
          averagePrice: avg,
          ltp,
          pnl,
        };
      }
      return {
        symbol: p?.tradingsymbol ?? p?.symbol ?? '—',
        exchange: p?.exchange ?? null,
        product: p?.product ?? null,
        quantity: this.num(p?.quantity),
        averagePrice: this.num(p?.average_price),
        ltp: this.num(p?.last_price),
        pnl: this.num(p?.pnl),
      };
    });
  }

  private normalizeOrders(broker: Broker, raw: any) {
    const list = this.toArray(broker, raw, ['orderBook']);
    if (!list) return null;
    return list.map((o: any) => {
      if (broker === Broker.FYERS) {
        return {
          orderId: o?.id ?? '—',
          symbol: o?.symbol ?? '—',
          side: o?.side === 1 ? 'BUY' : o?.side === -1 ? 'SELL' : null,
          quantity: this.num(o?.qty),
          price: this.num(o?.limitPrice ?? o?.tradedPrice),
          status: o?.status != null ? String(o.status) : null,
          orderType: o?.type != null ? String(o.type) : null,
          time: o?.orderDateTime ?? null,
        };
      }
      if (broker === Broker.SHOONYA) {
        return {
          orderId: o?.norenordno ?? '—',
          symbol: o?.tsym ?? '—',
          side: o?.trantype === 'B' ? 'BUY' : o?.trantype === 'S' ? 'SELL' : null,
          quantity: this.num(o?.qty),
          price: this.num(o?.prc),
          status: o?.status ?? null,
          orderType: o?.prctyp ?? null,
          time: o?.norentm ?? null,
        };
      }
      if (broker === Broker.ICICI_DIRECT) {
        // Breeze order_list → { order_id, stock_code, action, product_type,
        // quantity, pending_quantity, price, status, order_datetime }.
        const action = o?.action != null ? String(o.action).toUpperCase() : null;
        const qty = this.num(o?.quantity);
        const pending = this.num(o?.pending_quantity);
        const filled =
          qty !== null && pending !== null
            ? qty - pending
            : this.num(o?.filled_quantity ?? o?.executed_quantity);
        return {
          orderId: o?.order_id ?? '—',
          symbol: o?.stock_code ?? '—',
          side: action,
          product: o?.product_type ?? o?.product ?? null,
          quantity: qty,
          filledQuantity: filled,
          price: this.num(o?.price ?? o?.average_price),
          status: o?.status ?? null,
          orderType: o?.order_type ?? null,
          time: o?.order_datetime ?? o?.order_date ?? null,
        };
      }
      return {
        orderId: o?.order_id ?? o?.id ?? '—',
        symbol: o?.tradingsymbol ?? o?.symbol ?? '—',
        side: o?.transaction_type ?? o?.side ?? null,
        quantity: this.num(o?.quantity),
        price: this.num(o?.price ?? o?.average_price),
        status: o?.status ?? null,
        orderType: o?.order_type ?? null,
        time: o?.order_timestamp ?? o?.exchange_timestamp ?? null,
      };
    });
  }

  private normalizeTrades(broker: Broker, raw: any) {
    const list = this.toArray(broker, raw, ['tradeBook']);
    if (!list) return null;
    return list.map((t: any) => {
      if (broker === Broker.FYERS) {
        return {
          tradeId: t?.id ?? t?.orderNumber ?? '—',
          orderId: t?.orderNumber ?? null,
          symbol: t?.symbol ?? '—',
          side: t?.side === 1 ? 'BUY' : t?.side === -1 ? 'SELL' : null,
          quantity: this.num(t?.tradedQty ?? t?.qty),
          price: this.num(t?.tradePrice),
          time: t?.orderDateTime ?? null,
        };
      }
      if (broker === Broker.SHOONYA) {
        return {
          tradeId: t?.flid ?? t?.norenordno ?? '—',
          orderId: t?.norenordno ?? null,
          symbol: t?.tsym ?? '—',
          side: t?.trantype === 'B' ? 'BUY' : t?.trantype === 'S' ? 'SELL' : null,
          quantity: this.num(t?.flqty ?? t?.qty),
          price: this.num(t?.flprc ?? t?.prc),
          time: t?.fltm ?? t?.norentm ?? null,
        };
      }
      if (broker === Broker.ICICI_DIRECT) {
        // Breeze trade_list → { trade_id, order_id, stock_code, action,
        // product_type, quantity, average_cost, trade_date }.
        const action = t?.action != null ? String(t.action).toUpperCase() : null;
        return {
          tradeId: t?.trade_id ?? t?.order_id ?? '—',
          orderId: t?.order_id ?? null,
          symbol: t?.stock_code ?? '—',
          side: action,
          product: t?.product_type ?? null,
          quantity: this.num(t?.quantity),
          price: this.num(t?.average_cost ?? t?.price ?? t?.traded_price ?? t?.ltp),
          time: t?.trade_date ?? t?.trade_datetime ?? null,
        };
      }
      return {
        tradeId: t?.trade_id ?? t?.id ?? '—',
        orderId: t?.order_id ?? null,
        symbol: t?.tradingsymbol ?? t?.symbol ?? '—',
        side: t?.transaction_type ?? t?.side ?? null,
        quantity: this.num(t?.quantity),
        price: this.num(t?.average_price ?? t?.price),
        time: t?.fill_timestamp ?? t?.exchange_timestamp ?? null,
      };
    });
  }

  private buildLiveProfile(profile: any, caps: BrokerCapabilities, profileOk: boolean) {
    return {
      userName: profile?.userName ?? null,
      email: profile?.email ?? null,
      mobile: profile?.mobile ?? null,
      accountType: profile?.accountType ?? null,
      rmsStatus: profile?.rmsStatus ?? null,
      exchanges:
        caps.exchanges && Array.isArray(profile?.exchanges) ? profile.exchanges : null,
      products:
        caps.products && Array.isArray(profile?.products) ? profile.products : null,
      segments: Array.isArray(profile?.segments) ? profile.segments : null,
      profileStatus: profile?.profileStatus ?? (profileOk ? 'ACTIVE' : null),
    };
  }

  private portfolioSummary(holdings: any[] | null) {
    if (!holdings || holdings.length === 0) return null;
    let totalValue = 0;
    let totalPnl = 0;
    let hasValue = false;
    let hasPnl = false;
    for (const h of holdings) {
      if (h.currentValue !== null) {
        totalValue += h.currentValue;
        hasValue = true;
      }
      if (h.pnl !== null) {
        totalPnl += h.pnl;
        hasPnl = true;
      }
    }
    return {
      instruments: holdings.length,
      totalValue: hasValue ? Number(totalValue.toFixed(2)) : null,
      totalPnl: hasPnl ? Number(totalPnl.toFixed(2)) : null,
    };
  }

  /**
   * Sprint 6.1.5 — Full SDK-driven broker dashboard for a follower/master
   * account. Reuses getDashboard() (single live probe) and reshapes it into
   * the typed, capability-aware DTO the operational dashboard renders.
   */
  async getBrokerDashboard(accountId: string) {
    const { account } = await this.loadContext(accountId);
    const capabilities = this.capabilitiesFor(account.broker);
    const features = this.featuresFor(account.broker);

    const dash = await this.getDashboard(accountId);
    const profile: any = dash.profile;
    const health: any = dash.health;
    const profileOk = dash.errors.profile === null && profile !== null;

    const holdings = capabilities.holdings ? this.normalizeHoldings(account.broker, dash.holdings) : null;
    const positions = capabilities.positions
      ? this.normalizePositions(account.broker, dash.positions)
      : null;
    const orders = capabilities.orders ? this.normalizeOrders(account.broker, dash.orders) : null;
    const trades = capabilities.trades ? this.normalizeTrades(account.broker, dash.trades) : null;

    return {
      broker: account.broker,
      clientId: account.clientId,
      capabilities,
      features,
      health,
      profile: this.buildLiveProfile(profile, capabilities, profileOk),
      funds: capabilities.funds ? dash.funds : null,
      holdings,
      positions,
      orders,
      trades,
      portfolio: features.supportsPortfolio ? this.portfolioSummary(holdings) : null,
      errors: dash.errors,
    };
  }

  /**
   * Sprint 6.1.5 — Granular SDK refresh for a single dashboard section. Calls
   * exactly one broker SDK method (no cached data). Returns a capability-aware
   * envelope so the UI can show "Not supported by broker" honestly.
   */
  async getBrokerSection(
    accountId: string,
    section: 'profile' | 'funds' | 'holdings' | 'positions' | 'orders' | 'trades',
  ) {
    const { account, session } = await this.loadContext(accountId);
    const capabilities = this.capabilitiesFor(account.broker);

    const capMap: Record<typeof section, boolean> = {
      profile: capabilities.profile,
      funds: capabilities.funds,
      holdings: capabilities.holdings,
      positions: capabilities.positions,
      orders: capabilities.orders,
      trades: capabilities.trades,
    };
    const methodMap: Record<typeof section, string> = {
      profile: 'getProfile',
      funds: 'getMargins',
      holdings: 'getHoldings',
      positions: 'getPositions',
      orders: 'getOrders',
      trades: 'getTrades',
    };

    if (!capMap[section]) {
      return { section, supported: false, data: null, error: null };
    }
    if (!session) {
      return {
        section,
        supported: true,
        data: null,
        error: 'No active broker session. Please connect the broker.',
      };
    }

    const adapter = this.buildAdapter(
      account.broker,
      this.encryption.decrypt(session.encryptedAccessToken),
      session.userId ?? account.clientId,
      this.iciciCreds(account),
    );
    const settled = await Promise.allSettled([
      this.safeCall(adapter, methodMap[section]),
    ]);
    const s = settle(settled[0]);
    if (s.error) {
      return { section, supported: true, data: null, error: s.error };
    }

    let data: any = s.data;
    if (section === 'funds') data = this.normalizeFunds(account.broker, s.data);
    else if (section === 'holdings') data = this.normalizeHoldings(account.broker, s.data);
    else if (section === 'positions') data = this.normalizePositions(account.broker, s.data);
    else if (section === 'orders') data = this.normalizeOrders(account.broker, s.data);
    else if (section === 'trades') data = this.normalizeTrades(account.broker, s.data);
    else if (section === 'profile')
      data = this.buildLiveProfile(s.data, capabilities, true);

    return { section, supported: true, data, error: null };
  }
}
