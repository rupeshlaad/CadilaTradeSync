import axios from 'axios';
import { createHash } from 'crypto';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

/**
 * Sprint 6.2.0 — Full ICICI Direct (Breeze API v1) adapter.
 *
 * Breeze is a REST API (base https://api.icicidirect.com/breezeapi/api/v1/).
 * Authentication is a two-step, OAuth-style daily-session flow:
 *
 *   1. The user logs in at
 *      https://api.icicidirect.com/apiuser/login?api_key=<url-encoded appkey>
 *      and is redirected back with a short-lived API session token.
 *   2. `customerdetails` is called once with { SessionToken, AppKey } to
 *      resolve the account user id + the working session key (returned base64
 *      encoded as "<user_id>:<session_key>").
 *
 * Every subsequent data call is authenticated with the four required headers:
 *   X-Timestamp  (ISO8601 UTC, milliseconds forced to .000Z)
 *   X-AppKey     (the API/app key)
 *   X-SessionToken (the resolved session key)
 *   X-Checksum   ("token " + SHA256(timestamp + jsonBody + secret_key))
 *
 * The raw API session token (stored as BrokerSession.encryptedAccessToken) is
 * exchanged lazily via `ensureSession()` so a freshly-built adapter can serve
 * getProfile()/funds/holdings/… on the same request without re-plumbing the
 * session key through the shared BrokerService.
 */
export class ICICIDirectAdapter implements BrokerAdapter {
  /** Breeze exposes the full account-data surface officially. */
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
    supportsLogout: false,
    supportsSessionRefresh: false,
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
    supportsTokenRefresh: false,
    supportsMFA: true,
  };

  private readonly baseUrl = 'https://api.icicidirect.com/breezeapi/api/v1/';
  private readonly loginUrl = 'https://api.icicidirect.com/apiuser/login?api_key=';

  private apiKey = '';
  private secretKey = '';
  private rawSessionToken = '';
  private sessionKey = '';
  private uid = '';
  private userName = '';
  private customer: any = null;

  setCredentials(apiKey: string, secretKey: string) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
  }

  /** Raw API session token from the login redirect. */
  setSessionToken(rawSessionToken: string) {
    this.rawSessionToken = rawSessionToken;
  }

  setUserId(userId: string) {
    this.uid = userId;
  }

  getLoginUrl(): string {
    return this.loginUrl + encodeURIComponent(this.apiKey);
  }

  /**
   * Exchange the raw API session token for a working Breeze session. Resolves
   * the user id + session key via customerdetails and returns the token to be
   * persisted (the raw session token — it is re-resolved on each request).
   */
  async exchangeToken(rawSessionToken: string): Promise<any> {
    this.rawSessionToken = rawSessionToken;
    await this.ensureSession();
    return {
      access_token: this.rawSessionToken,
      session_token: this.rawSessionToken,
      user_id: this.uid,
    };
  }

  /**
   * Resolve (and memoize) the working session key + user id from the raw API
   * session token. Idempotent within an adapter instance so getProfile() and
   * the data calls only hit customerdetails once per request.
   */
  private async ensureSession(): Promise<void> {
    if (this.sessionKey) return;
    if (!this.rawSessionToken) {
      throw new Error('ICICI Direct session token missing. Please reconnect.');
    }
    const data = await this.customerDetails(this.rawSessionToken);
    const success = data?.Success ?? {};
    const b64 = success.session_token;
    if (b64) {
      try {
        const decoded = Buffer.from(String(b64), 'base64').toString('utf-8');
        if (decoded.includes(':')) {
          const [uid, ...rest] = decoded.split(':');
          if (!this.uid) this.uid = uid;
          this.sessionKey = rest.join(':');
        } else {
          this.sessionKey = String(b64);
        }
      } catch {
        this.sessionKey = String(b64);
      }
    }
    if (!this.sessionKey) this.sessionKey = this.rawSessionToken;
    if (!this.uid) this.uid = success.idirect_userid ?? success.user_id ?? '';
    this.userName =
      success.idirect_user_name ?? success.user_name ?? this.uid ?? '';
    this.customer = success;
  }

  /** Bootstrap call — no checksum headers; auth is the SessionToken + AppKey. */
  private async customerDetails(rawToken: string): Promise<any> {
    const body = JSON.stringify({ SessionToken: rawToken, AppKey: this.apiKey });
    const { data } = await axios.request({
      method: 'GET',
      url: `${this.baseUrl}customerdetails`,
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });
    if (data && data.Error) {
      throw new Error(String(data.Error));
    }
    return data;
  }

  private timestamp(): string {
    return new Date().toISOString().split('.')[0] + '.000Z';
  }

  private generateHeaders(body: string): Record<string, string> {
    const ts = this.timestamp();
    const checksum = createHash('sha256')
      .update(ts + body + this.secretKey)
      .digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-Checksum': 'token ' + checksum,
      'X-Timestamp': ts,
      'X-AppKey': this.apiKey,
      'X-SessionToken': this.sessionKey,
    };
  }

  /** Authenticated Breeze GET (Breeze GET requests carry a JSON body). */
  private async get(endpoint: string, payload: Record<string, any>): Promise<any> {
    await this.ensureSession();
    const body = JSON.stringify(payload ?? {});
    const headers = this.generateHeaders(body);
    const { data } = await axios.request({
      method: 'GET',
      url: `${this.baseUrl}${endpoint}`,
      data: body,
      headers,
    });
    if (data && data.Error) {
      throw new Error(String(data.Error));
    }
    return data && data.Success !== undefined ? data.Success : data;
  }

  private todayRange(): { from_date: string; to_date: string } {
    const now = new Date();
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    return {
      from_date: from.toISOString().split('.')[0] + '.000Z',
      to_date: now.toISOString().split('.')[0] + '.000Z',
    };
  }

  private segmentsFrom(customer: any): string[] | undefined {
    const seg = customer?.segments_allowed;
    if (seg && typeof seg === 'object' && !Array.isArray(seg)) {
      const enabled = Object.keys(seg).filter(
        (k) => String(seg[k]).toUpperCase() === 'Y',
      );
      return enabled.length > 0 ? enabled : undefined;
    }
    if (Array.isArray(seg)) return seg;
    return undefined;
  }

  async getProfile(): Promise<BrokerProfile> {
    await this.ensureSession();
    const c = this.customer ?? {};
    const segments = this.segmentsFrom(c);
    return {
      broker: 'ICICI_DIRECT',
      userId: this.uid,
      userName: this.userName || this.uid,
      email: c.email_id ?? undefined,
      mobile: c.mobile_no ?? undefined,
      exchanges: segments,
      segments,
      accountType: c.idirect_userid ? 'INDIVIDUAL' : undefined,
      profileStatus: 'ACTIVE',
    };
  }

  // Breeze exposes account balances/limits through the `funds` endpoint;
  // there is no distinct account-level margin snapshot, so funds serves both.
  async getMargins() {
    return this.get('funds', {});
  }

  async getFunds() {
    return this.get('funds', {});
  }

  async getHoldings() {
    return this.get('dematholdings', {});
  }

  async getPositions() {
    return this.get('portfoliopositions', {});
  }

  async getOrders() {
    // Breeze order_list mandates exchange_code + a date range; default to the
    // current trading day on NSE (documented SDK limitation).
    return this.get('order', { exchange_code: 'NSE', ...this.todayRange() });
  }

  async getTrades() {
    // Breeze trade_list mandates exchange_code + a date range; default to the
    // current trading day on NSE (documented SDK limitation).
    return this.get('trades', { exchange_code: 'NSE', ...this.todayRange() });
  }

  async getPortfolio() {
    // portfolioholdings mandates exchange_code; demat holdings is the broader
    // cross-exchange view used by the dashboard portfolio summary.
    return this.get('dematholdings', {});
  }

  async getExchanges(): Promise<string[] | null> {
    await this.ensureSession();
    return this.segmentsFrom(this.customer) ?? null;
  }

  async getProducts(): Promise<string[] | null> {
    return null; // Not enumerated by the Breeze customer-details payload.
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    return {
      supported: false,
      reason:
        'Breeze API exposes no logout/invalidate endpoint; the API session is invalidated daily at midnight IST.',
    };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    return {
      supported: false,
      reason:
        'Breeze API has no token refresh; a fresh daily login is required to obtain a new API session token.',
    };
  }

  // Order execution is intentionally out of scope for Sprint 6.2.0.
  async placeOrder(_order: any) {
    return {};
  }

  async modifyOrder(_orderId: string, _order: any) {
    return {};
  }

  async cancelOrder(_orderId: string) {
    return {};
  }
}
