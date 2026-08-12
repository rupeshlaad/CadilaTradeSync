import { Logger } from '@nestjs/common';
import { fyersModel } from 'fyers-api-v3';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

// ---------------------------------------------------------------------------
// TEMPORARY DIAGNOSTICS (Fyers order request/response instrumentation)
// -----------------------------------------------------------------------------
// Added to capture an exact engineering log of what CTS sends to the Fyers
// Order API before raising a Fyers support case (broker error code -50 "Algo
// orders are not allowed from this app"). This block ONLY logs — it does not
// change the payload, headers, authentication, retry or error handling. Remove
// once the support case is resolved.
//
// The `fyers-api-v3` SDK targets the v3 order endpoint below (documented +
// SDK constant `DefaultBaseURI`); the SDK abstracts the underlying axios call,
// so raw HTTP status/headers are not exposed to this layer — logged as such.
const FYERS_API_BASE_URL = 'https://api-t1.fyers.in/api/v3';
const FYERS_PLACE_ORDER_PATH = '/orders/sync';

/** Optional per-call diagnostic context supplied by the calling service. */
export interface FyersOrderDiagnosticContext {
  tradingAccountId?: string | null;
  brokerUserId?: string | null;
  sourceModule?: string | null;
  environment?: string | null;
  accessTokenExpiry?: string | null;
}

/**
 * Render the Fyers Authorization header (`appId:accessToken`) for the log,
 * showing only the first 12 characters then `****`. The window is capped at
 * the `appId:` boundary so the secret access token is NEVER exposed, even for
 * a short/misconfigured App ID (the App ID itself is a public client id and is
 * already logged in full on its own line).
 */
function maskAuthHeader(appId: string, accessToken?: string | null): string {
  if (!appId && !accessToken) return '(none)';
  const header = `${appId}:${accessToken ?? ''}`;
  const boundary = appId.length + 1; // through the ':' — never into the token
  const window = Math.min(12, boundary);
  return `${header.slice(0, window)}****`;
}

function decodeFyersOrderType(type: unknown): string {
  switch (type) {
    case 1:
      return '1 (LIMIT)';
    case 2:
      return '2 (MARKET)';
    case 3:
      return '3 (SL-M / STOP)';
    case 4:
      return '4 (SL / STOP-LIMIT)';
    default:
      return String(type ?? '(none)');
  }
}

function decodeFyersSide(side: unknown): string {
  if (side === 1) return '1 (BUY)';
  if (side === -1) return '-1 (SELL)';
  return String(side ?? '(none)');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Sprint 6.1.6 — Full Fyers API v3 adapter.
 *
 * The official `fyers-api-v3` (v2.0.0) client exposes the complete trading
 * surface as instance methods: get_profile, get_funds, get_holdings,
 * get_positions, get_orders, get_tradebook, logout_user, place/modify/cancel.
 * All of these are now wired. Exchanges/products are NOT part of the Fyers
 * profile payload, so they are honestly declared unsupported.
 */
export class FyersAdapter implements BrokerAdapter {
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: false,
    products: false,
    funds: true,
    margin: true,
    holdings: true,
    positions: true,
    orders: true,
    trades: true,
  };

  static readonly features: BrokerFeatureSupport = {
    supportsProfile: true,
    supportsFunds: true,
    supportsMargins: true,
    supportsHoldings: true,
    supportsPositions: true,
    supportsOrders: true,
    supportsTrades: true,
    supportsPortfolio: true,
    supportsAutoLogin: false,
    supportsLogout: true,
    supportsSessionRefresh: true,
  };

  static readonly onboarding: BrokerOnboardingRequirements = {
    requiresOAuth: true,
    requiresApiKey: true,
    requiresSecret: true,
    requiresPassword: false,
    requiresPIN: false,
    requiresTOTP: false,
    requiresStaticIP: false,
    requiresRedirect: true,
    requiresVendorCode: false,
    supportsAutoLogin: false,
    supportsTokenRefresh: true,
    supportsMFA: false,
  };

  private fyers: any;
  // TEMPORARY DIAGNOSTICS — logger + captured values used ONLY to build the
  // Fyers order request/response log. None of these influence the SDK call.
  private readonly logger = new Logger('FyersAdapter');
  private accessTokenForDiag: string = '';
  private orderDiagnosticContext: FyersOrderDiagnosticContext = {};
  // Sprint 6.2.15 — per-account Fyers credentials. Default to the legacy env
  // values so an adapter built without setCredentials() is byte-identical to
  // the previous single-account behaviour; a per-account adapter overrides them
  // via setCredentials().
  private appId: string = process.env.FYERS_APP_ID ?? '';
  private secretId: string = process.env.FYERS_SECRET_ID ?? '';

  constructor() {
    this.fyers = new fyersModel();
    this.fyers.setAppId(this.appId);
    this.fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI!);
  }

  /**
   * Sprint 6.2.15 — account isolation. Mirrors ICICIDirectAdapter.setCredentials:
   * every Fyers TradingAccount uses its OWN App ID (api key) + Secret ID
   * (api secret), never the global FYERS_APP_ID/FYERS_SECRET_ID. The App ID
   * drives the OAuth login URL, the generate_access_token exchange AND the
   * authenticated request header (`appId:accessToken`), so it must be set on
   * the SDK instance before any of login / exchange / read is called. This is
   * what makes two Fyers accounts (e.g. Dimple vs Rupesh) resolve to their own
   * profile instead of whichever account owns the env App ID.
   */
  setCredentials(appId: string, secretId: string) {
    // Sprint 6.2.18 — trim the per-account App ID + Secret. Fyers rejects a
    // client_id with stray whitespace/newline (a common copy-paste artefact
    // from the developer portal) as "invalid appId" on the login page. Dimple's
    // App ID was pasted clean and works; a contaminated value (e.g. a trailing
    // newline) is sent as client_id=...%0A and fails. Trimming is safe for
    // every account and never alters a clean value.
    this.appId = (appId ?? '').trim();
    this.secretId = (secretId ?? '').trim();
    this.fyers.setAppId(this.appId);
  }

  setAccessToken(accessToken: string) {
    this.fyers.setAccessToken(accessToken);
    // TEMPORARY DIAGNOSTICS — retain the token ONLY to render the masked
    // Authorization-header preview in the order log. Authentication is
    // unchanged: the SDK still uses the token set above.
    this.accessTokenForDiag = accessToken ?? '';
  }

  /**
   * TEMPORARY DIAGNOSTICS — optional context the calling service can attach so
   * the Fyers order log carries the TradingAccountId / Broker User ID / source
   * module. Purely additive: it is NOT part of the BrokerAdapter interface,
   * never touches the SDK, payload, headers or auth, and defaults to empty so
   * callers that do not set it are byte-identical.
   */
  setOrderDiagnosticContext(ctx: FyersOrderDiagnosticContext) {
    this.orderDiagnosticContext = ctx ?? {};
  }

  getLoginUrl(state?: string): string {
    // Sprint 6.2.17 — pass the self-contained OAuth state token so the broker
    // echoes it back on the callback (reconnect context survives without any
    // server-side memory). When omitted, the SDK default is used (unchanged).
    return state
      ? this.fyers.generateAuthCode({ state })
      : this.fyers.generateAuthCode();
  }

  async exchangeToken(token: string): Promise<any> {
    const session = await this.fyers.generate_access_token({
      client_id: this.appId,
      secret_key: this.secretId,
      auth_code: token,
    });
    this.fyers.setAccessToken(session.access_token);
    return session;
  }

  private unwrap(res: any, key: string): any {
    // Fyers responses are { s: 'ok', code, message, <key>: ... }.
    if (res && res.s && res.s !== 'ok') {
      throw new Error(res.message || `Fyers error (${res.code ?? 'unknown'})`);
    }
    return res?.[key] ?? res;
  }

  async getProfile(): Promise<BrokerProfile> {
    const res = await this.fyers.get_profile();
    const d = this.unwrap(res, 'data') ?? {};
    return {
      broker: 'FYERS',
      userId: d.fy_id,
      userName: d.name ?? d.display_name,
      email: d.email_id,
      mobile: d.mobile_number ?? undefined,
      accountType: d.pan ? 'INDIVIDUAL' : undefined,
      profileStatus: 'ACTIVE',
    };
  }

  async getMargins() {
    // Fyers exposes funds + margin through the same get_funds() endpoint.
    return this.fyers.get_funds();
  }

  async getFunds() {
    return this.fyers.get_funds();
  }

  async getHoldings() {
    return this.fyers.get_holdings();
  }

  async getPositions() {
    return this.fyers.get_positions();
  }

  async getOrders() {
    return this.fyers.get_orders();
  }

  async getTrades() {
    return this.fyers.get_tradebook();
  }

  async getPortfolio() {
    return this.fyers.get_holdings();
  }

  async getExchanges(): Promise<string[] | null> {
    return null; // Not part of the Fyers profile payload.
  }

  async getProducts(): Promise<string[] | null> {
    return null; // Not part of the Fyers profile payload.
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    const data = await this.fyers.logout_user();
    return { supported: true, data };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    // Fyers supports a refresh-token flow, but it requires the stored refresh
    // token + PIN which the current session model does not persist. Declared
    // supported-at-SDK but not yet wired end-to-end.
    return {
      supported: false,
      reason:
        'Fyers refresh requires a stored refresh token + PIN (not yet persisted in CTS).',
    };
  }

  async placeOrder(order: any) {
    // ===================================================================
    // TEMPORARY DIAGNOSTICS — this is the EXACT site that calls the Fyers
    // Order API (`fyers-api-v3` place_order → POST /orders/sync). The three
    // log blocks below ONLY log; the payload, headers, authentication, retry
    // and error propagation are all unchanged.
    // ===================================================================
    const ctx = this.orderDiagnosticContext;
    const startedAt = Date.now();
    const exchange =
      typeof order?.symbol === 'string' && order.symbol.includes(':')
        ? order.symbol.split(':')[0]
        : '(embedded in symbol)';

    this.logger.warn(
      [
        '',
        '========== FYERS ORDER REQUEST ==========',
        `Timestamp            : ${new Date().toISOString()}`,
        `TradingAccountId     : ${ctx.tradingAccountId ?? '(not provided)'}`,
        `Broker User ID       : ${ctx.brokerUserId ?? '(not provided)'}`,
        `Broker               : FYERS`,
        `Environment          : ${ctx.environment ?? process.env.NODE_ENV ?? '(unknown)'}`,
        `App ID being used    : ${this.appId || '(none)'}`,
        `Redirect URI         : ${process.env.FYERS_REDIRECT_URI ?? '(unset)'}`,
        `Base URL             : ${FYERS_API_BASE_URL}`,
        `Full endpoint URL    : ${FYERS_API_BASE_URL}${FYERS_PLACE_ORDER_PATH}`,
        `HTTP Method          : POST`,
        `Order payload        : ${safeJson(order)}`,
        `Authorization header : ${maskAuthHeader(this.appId, this.accessTokenForDiag)}`,
        `Access Token expiry  : ${ctx.accessTokenExpiry ?? '(not available at adapter layer)'}`,
        `Order Type           : ${decodeFyersOrderType(order?.type)}`,
        `Product Type         : ${order?.productType ?? '(none)'}`,
        `Side                 : ${decodeFyersSide(order?.side)}`,
        `Exchange             : ${exchange}`,
        `Symbol               : ${order?.symbol ?? '(none)'}`,
        `Qty                  : ${order?.qty ?? '(none)'}`,
        `Price (limitPrice)   : ${order?.limitPrice ?? '(none)'}`,
        `Trigger (stopPrice)  : ${order?.stopPrice ?? '(none)'}`,
        `Validity             : ${order?.validity ?? '(none)'}`,
        `Offline Order flag   : ${order?.offlineOrder ?? '(none)'}`,
        `Source Module        : ${ctx.sourceModule ?? '(not provided)'}`,
        '=========================================',
      ].join('\n'),
    );

    try {
      const response = await this.fyers.place_order(order);

      this.logger.warn(
        [
          '',
          '========== FYERS ORDER RESPONSE ==========',
          `HTTP Status          : ${
            response?.statusCode ??
            response?.code ??
            '(not exposed by fyers-api-v3 SDK — see Response Body)'
          }`,
          `Response Headers     : (not exposed by fyers-api-v3 SDK)`,
          `Response Body        : ${safeJson(response)}`,
          `Elapsed Time         : ${Date.now() - startedAt} ms`,
          `Fyers Request ID     : ${response?.request_id ?? response?.requestId ?? '(none)'}`,
          `Correlation ID       : ${response?.correlationId ?? response?.correlation_id ?? '(none)'}`,
          '==========================================',
        ].join('\n'),
      );

      return response;
    } catch (err: any) {
      this.logger.error(
        [
          '',
          '========== FYERS ORDER ERROR ==========',
          `Axios Error?         : ${!!(err?.isAxiosError || err?.response)}`,
          `HTTP Status          : ${err?.response?.status ?? err?.statusCode ?? '(none)'}`,
          `Response Body        : ${safeJson(err?.response?.data ?? err?.data ?? err?.message ?? err)}`,
          `Elapsed Time         : ${Date.now() - startedAt} ms`,
          `Stack                : ${err?.stack ?? '(none)'}`,
          '==========================================',
        ].join('\n'),
      );
      // Do NOT swallow — propagate the exact same error unchanged.
      throw err;
    }
  }

  async modifyOrder(orderId: string, order: any) {
    const payload = order?.id ? order : { ...order, id: orderId };
    return this.fyers.modify_order(payload);
  }

  async cancelOrder(orderId: string) {
    return this.fyers.cancel_order({ id: orderId });
  }

  async searchSymbol(symbol: string) {
    return this.fyers.search_symbol(symbol);
  }
}
