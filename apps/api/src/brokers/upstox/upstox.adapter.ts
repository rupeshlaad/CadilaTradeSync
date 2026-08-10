import axios from 'axios';
import { Logger } from '@nestjs/common';
import { upstoxRateLimiter } from './upstox-rate-limiter';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

/**
 * Sprint 6.3 — Full Upstox (Uplink REST API v2) adapter.
 *
 * Upstox uses the standard OAuth 2.0 authorization-code flow (mirrors the
 * Fyers onboarding shape) but is a plain REST API (mirrors the ICICI axios
 * transport — no vendor SDK dependency, so no lockfile change).
 *
 *   1. The user is sent to
 *      https://api.upstox.com/v2/login/authorization/dialog
 *        ?response_type=code&client_id=<apiKey>&redirect_uri=<redirect>&state=<state>
 *      and is redirected back with a single-use `code`.
 *   2. `exchangeToken(code)` POSTs (application/x-www-form-urlencoded) to
 *      https://api.upstox.com/v2/login/authorization/token with
 *      { code, client_id, client_secret, redirect_uri, grant_type } and
 *      returns the daily `access_token` (valid until ~03:30 IST next day).
 *
 * Every subsequent call is authenticated with `Authorization: Bearer <token>`
 * and `Accept: application/json`. Credentials (client_id = api key,
 * client_secret = api secret) are PER-ACCOUNT — never global env — so two
 * Upstox accounts never cross over (same isolation guarantee as Fyers/ICICI).
 */
export class UpstoxAdapter implements BrokerAdapter {
  /** Upstox exposes the full account-data surface officially. */
  static readonly capabilities: BrokerCapabilities = {
    profile: true,
    exchanges: true,
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
    supportsSessionRefresh: false,
  };

  static readonly onboarding: BrokerOnboardingRequirements = {
    requiresOAuth: true,
    requiresApiKey: true,
    requiresSecret: true,
    requiresPassword: false,
    requiresPIN: false,
    requiresTOTP: false,
    // Sprint 6.3.1 — Upstox order APIs (place/modify/cancel/exit) must
    // originate from a registered static IP (SEBI algo-trading regulation +
    // Upstox developer-console app static-IP whitelisting). Read/data APIs are
    // not IP-restricted, but onboarding must reflect the order-API requirement.
    requiresStaticIP: true,
    requiresRedirect: true,
    requiresVendorCode: false,
    supportsAutoLogin: false,
    supportsTokenRefresh: false,
    supportsMFA: true,
  };

  private readonly baseUrl = 'https://api.upstox.com/v2';
  // Sprint 6.3.1 — order placement/modify/cancel moved to the latest
  // officially-supported V3 order APIs on the HFT host (v2 order APIs are
  // deprecated per Upstox's deprecation notice). Data/read APIs stay on v2.
  private readonly orderBaseUrl = 'https://api-hft.upstox.com/v3';
  private readonly logger = new Logger('UpstoxAdapter');

  // Per-account OAuth credentials (never env-based). Default to the optional
  // env values only so an adapter built without setCredentials() still boots.
  private apiKey: string = process.env.UPSTOX_API_KEY ?? '';
  private apiSecret: string = process.env.UPSTOX_API_SECRET ?? '';
  private redirectUri: string = process.env.UPSTOX_REDIRECT_URI ?? '';
  private accessToken = '';

  setCredentials(apiKey: string, apiSecret: string) {
    // Trim copy-paste artefacts (trailing newline/spaces) that would otherwise
    // be sent verbatim as client_id/client_secret and rejected by Upstox.
    this.apiKey = (apiKey ?? '').trim();
    this.apiSecret = (apiSecret ?? '').trim();
  }

  setRedirectUri(redirectUri: string) {
    this.redirectUri = (redirectUri ?? '').trim();
  }

  setAccessToken(accessToken: string) {
    this.accessToken = accessToken;
  }

  getLoginUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.apiKey,
      redirect_uri: this.redirectUri,
    });
    if (state) params.set('state', state);
    return `${this.baseUrl}/login/authorization/dialog?${params.toString()}`;
  }

  /**
   * Exchange the single-use authorization `code` for the daily access token.
   * Upstox requires an `application/x-www-form-urlencoded` body.
   */
  async exchangeToken(code: string): Promise<any> {
    const body = new URLSearchParams({
      code,
      client_id: this.apiKey,
      client_secret: this.apiSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    const { data } = await axios.post(
      `${this.baseUrl}/login/authorization/token`,
      body.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      },
    );
    // Upstox response: { email, exchanges, products, ..., user_id, user_name,
    //   access_token, extended_token, ... }
    if (data?.access_token) this.accessToken = data.access_token;
    return {
      access_token: data?.access_token ?? '',
      user_id: data?.user_id,
      user_name: data?.user_name,
      email: data?.email,
      raw: data,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };
  }

  private mask(v?: string): string {
    if (!v) return 'none';
    const s = String(v);
    return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`;
  }

  /** Authenticated Upstox GET (data API — rate-limited). Returns `{status,data}`. */
  private async get(path: string): Promise<any> {
    await upstoxRateLimiter.acquire('data');
    this.logger.log(
      `[Upstox GET] ${this.baseUrl}${path} | token=${this.mask(this.accessToken)}`,
    );
    try {
      const { data, status } = await axios.get(`${this.baseUrl}${path}`, {
        headers: this.headers(),
      });
      this.logResponse(path, status, data);
      return data;
    } catch (err: any) {
      this.logResponse(path, err?.response?.status, err?.response?.data ?? err?.message);
      throw normalizeUpstoxError(err);
    }
  }

  /**
   * Authenticated write request. `bucket` selects the correct Upstox rate
   * window ('order' for V3 order APIs, 'data' otherwise). When `absoluteUrl`
   * is passed the V3 HFT host is used verbatim; otherwise the v2 base is used.
   */
  private async send(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: Record<string, any>,
    opts?: { bucket?: 'order' | 'data'; absoluteUrl?: string },
  ): Promise<any> {
    const bucket = opts?.bucket ?? 'data';
    await upstoxRateLimiter.acquire(bucket);
    const url = opts?.absoluteUrl ?? `${this.baseUrl}${path}`;
    this.logger.log(
      `[Upstox ${method}] ${url} | token=${this.mask(
        this.accessToken,
      )} | body=${payload ? JSON.stringify(payload) : 'none'}`,
    );
    try {
      const { data, status } = await axios.request({
        method,
        url,
        data: payload,
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
      });
      this.logResponse(path, status, data);
      return data;
    } catch (err: any) {
      this.logResponse(path, err?.response?.status, err?.response?.data ?? err?.message);
      throw normalizeUpstoxError(err);
    }
  }

  private logResponse(path: string, status: any, data: any): void {
    let raw: string;
    try {
      raw = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      raw = '[unserializable]';
    }
    if (raw && raw.length > 1500) raw = raw.slice(0, 1500) + '…[truncated]';
    this.logger.log(`[Upstox RESP] ${path} | status: ${status ?? 'n/a'} | body: ${raw}`);
  }

  async getProfile(): Promise<BrokerProfile> {
    const res = await this.get('/user/profile');
    const d = res?.data ?? {};
    return {
      broker: 'UPSTOX',
      userId: d.user_id,
      userName: d.user_name ?? d.user_id,
      email: d.email ?? undefined,
      exchanges: Array.isArray(d.exchanges) ? d.exchanges : undefined,
      products: Array.isArray(d.products) ? d.products : undefined,
      segments: Array.isArray(d.exchanges) ? d.exchanges : undefined,
      accountType: d.user_type ?? undefined,
      profileStatus: d.is_active === false ? 'INACTIVE' : 'ACTIVE',
    };
  }

  async getMargins() {
    // Upstox exposes funds + margin through one endpoint.
    const res = await this.get('/user/get-funds-and-margin');
    return res?.data ?? res;
  }

  async getFunds() {
    const res = await this.get('/user/get-funds-and-margin');
    return res?.data ?? res;
  }

  async getHoldings() {
    return this.get('/portfolio/long-term-holdings');
  }

  async getPositions() {
    return this.get('/portfolio/short-term-positions');
  }

  async getOrders() {
    return this.get('/order/retrieve-all');
  }

  async getTrades() {
    return this.get('/order/trades/get-trades-for-day');
  }

  async getPortfolio() {
    return this.get('/portfolio/long-term-holdings');
  }

  async getExchanges(): Promise<string[] | null> {
    const res = await this.get('/user/profile').catch(() => null);
    const ex = res?.data?.exchanges;
    return Array.isArray(ex) ? ex : null;
  }

  async getProducts(): Promise<string[] | null> {
    const res = await this.get('/user/profile').catch(() => null);
    const p = res?.data?.products;
    return Array.isArray(p) ? p : null;
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    const data = await this.send('DELETE', '/logout');
    return { supported: true, data };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    return {
      supported: false,
      reason:
        'Upstox has no token-refresh flow; a fresh daily OAuth login is required for a new access token.',
    };
  }

  /**
   * Live authenticated probe used by the OAuth callback / session validation
   * to confirm the persisted access token actually works against an official
   * Upstox endpoint before the broker is marked Connected. Returns the broker
   * user id on success; throws the verbatim broker error on failure.
   */
  async validateToken(): Promise<{ userId?: string }> {
    const profile = await this.getProfile();
    return { userId: profile?.userId };
  }

  /**
   * Upstox V3 `/order/place` on the HFT host (v2 order APIs are deprecated).
   * `order` is the already-shaped payload built by the shared
   * `buildUpstoxPlaceOrder` mapper (instrument_token, transaction_type,
   * order_type, product, quantity, price, trigger_price, validity,
   * disclosed_quantity, is_amo, slice, tag). Returns the
   * `{ status, data: { order_ids }, metadata }` V3 envelope.
   */
  async placeOrder(order: any) {
    return this.send('POST', '/order/place', order ?? {}, {
      bucket: 'order',
      absoluteUrl: `${this.orderBaseUrl}/order/place`,
    });
  }

  async modifyOrder(orderId: string, order: any) {
    return this.send(
      'PUT',
      '/order/modify',
      { order_id: orderId, ...(order ?? {}) },
      { bucket: 'order', absoluteUrl: `${this.orderBaseUrl}/order/modify` },
    );
  }

  async cancelOrder(orderId: string) {
    return this.send('DELETE', '/order/cancel', undefined, {
      bucket: 'order',
      absoluteUrl: `${this.orderBaseUrl}/order/cancel?order_id=${encodeURIComponent(
        orderId,
      )}`,
    });
  }
}

/**
 * Upstox error envelope → an Error carrying the EXACT broker message so the
 * UI (manual trade / copy trade) can surface it verbatim (never a generic
 * placeholder). Upstox errors are { status:'error', errors:[{ errorCode,
 * message, ... }] }.
 */
function normalizeUpstoxError(err: any): Error {
  const payload = err?.response?.data ?? err;
  const first =
    Array.isArray(payload?.errors) && payload.errors.length > 0
      ? payload.errors[0]
      : null;
  const message =
    first?.message ||
    payload?.message ||
    err?.message ||
    'Upstox request failed';
  const out = new Error(String(message));
  (out as any).error_type = first?.errorCode ?? payload?.status ?? 'UPSTOX_ERROR';
  (out as any).response = err?.response?.data ?? null;
  return out;
}
