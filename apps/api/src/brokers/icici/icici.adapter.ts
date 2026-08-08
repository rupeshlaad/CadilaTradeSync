import axios from 'axios';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
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

/**
 * Sprint 6.2.14 — process-wide Breeze session cache.
 *
 * Breeze `customerdetails` resolves the working session key from the raw daily
 * API session token. That resolution is stable for the life of the daily
 * session, so it is memoized ACROSS adapter instances (every manual trade,
 * Sync Broker cycle and dashboard call builds a fresh adapter). The cache is
 * refreshed ONLY when it is missing, older than 12h, or a request comes back
 * Unauthorized / invalid-session — never before every request.
 */
interface CachedBreezeSession {
  sessionKey: string;
  uid: string;
  userName: string;
  customer: any;
  fetchedAt: number;
}

const BREEZE_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const breezeSessionCache = new Map<string, CachedBreezeSession>();

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
  private readonly logger = new Logger('ICICIDirectAdapter');

  private apiKey = '';
  private secretKey = '';
  private rawSessionToken = '';
  private sessionKey = '';
  private uid = '';
  private userName = '';
  private customer: any = null;

  // Per-request LTP cache. Breeze has no bulk-quote endpoint, so we dedupe by
  // symbol (a stock appearing in both holdings and positions is fetched once)
  // to stay within the ~10 req/sec rate limit.
  private readonly quoteCache = new Map<string, number | null>();

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
   * session token. Idempotent within an adapter instance AND across instances
   * via the process-wide `breezeSessionCache` (Sprint 6.2.14) so
   * customerdetails is hit at most once per daily session (or on a forced
   * refresh), not once per adapter/request.
   */
  private async ensureSession(force = false): Promise<void> {
    if (this.sessionKey && !force) return;
    if (!this.rawSessionToken) {
      throw new Error('ICICI Direct session token missing. Please reconnect.');
    }

    // Reuse a still-valid cached session (shared across every adapter instance)
    // before falling back to a customerdetails round-trip.
    const cacheKey = this.sessionCacheKey();
    if (!force) {
      const cached = breezeSessionCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < BREEZE_SESSION_TTL_MS) {
        this.sessionKey = cached.sessionKey;
        if (!this.uid) this.uid = cached.uid;
        this.userName = this.userName || cached.userName;
        this.customer = cached.customer;
        return;
      }
    }

    const data = await this.customerDetails(this.rawSessionToken);
    const success = data?.Success ?? {};
    const b64 = success.session_token;
    // Breeze REST auth: X-SessionToken MUST be the base64 `session_token` blob
    // returned by customerdetails, used VERBATIM. It must NOT be base64-decoded
    // and split — the decoded "<user_id>:<key>" form is only for websocket
    // stream auth. Sending the split part makes Breeze fail to decode the
    // header ("Invalid length for a Base-64 char array or string" → 401) on
    // every checksum-authenticated call (funds/holdings/positions/orders/trades)
    // while customerdetails (which doesn't use X-SessionToken) still succeeds.
    if (b64) {
      this.sessionKey = String(b64);
      try {
        const decoded = Buffer.from(String(b64), 'base64').toString('utf-8');
        if (decoded.includes(':') && !this.uid) {
          this.uid = decoded.split(':')[0];
        }
      } catch {
        // Base64 decode is only for extracting the user id; the raw blob is
        // still the correct X-SessionToken value even if this fails.
      }
    }
    if (!this.sessionKey) this.sessionKey = this.rawSessionToken;
    if (!this.uid) this.uid = success.idirect_userid ?? success.user_id ?? '';
    this.userName =
      success.idirect_user_name ?? success.user_name ?? this.uid ?? '';
    this.customer = success;

    // Persist the resolved session for reuse by later adapter instances.
    breezeSessionCache.set(cacheKey, {
      sessionKey: this.sessionKey,
      uid: this.uid,
      userName: this.userName,
      customer: this.customer,
      fetchedAt: Date.now(),
    });

    this.logger.log(
      `[Breeze session] resolved uid=${this.uid || 'n/a'} sessionToken=${this.mask(
        this.sessionKey,
      )} (base64 blob used verbatim for X-SessionToken)`,
    );
  }

  /** Stable cache key for the current credentials + raw daily session token. */
  private sessionCacheKey(): string {
    return `${this.apiKey}:${this.rawSessionToken}`;
  }

  /** Drop the cached session (instance + process) so the next call re-resolves. */
  private invalidateSession(): void {
    this.sessionKey = '';
    breezeSessionCache.delete(this.sessionCacheKey());
  }

  /** Bootstrap call — no checksum headers; auth is the SessionToken + AppKey. */
  private async customerDetails(rawToken: string): Promise<any> {
    const body = JSON.stringify({ SessionToken: rawToken, AppKey: this.apiKey });
    const endpoint = 'customerdetails';
    this.logger.log(
      `[Breeze GET] ${this.baseUrl}${endpoint} | headers: ${JSON.stringify({
        'Content-Type': 'application/json',
      })} | body: ${JSON.stringify({
        SessionToken: this.mask(rawToken),
        AppKey: this.mask(this.apiKey),
      })}`,
    );
    try {
      const { data, status } = await axios.request({
        method: 'GET',
        url: `${this.baseUrl}${endpoint}`,
        data: body,
        headers: { 'Content-Type': 'application/json' },
      });
      this.logResponse(endpoint, status, data);
      if (data && data.Error) {
        throw new Error(String(data.Error));
      }
      return data;
    } catch (err: any) {
      this.logResponse(
        endpoint,
        err?.response?.status,
        err?.response?.data ?? err?.message,
      );
      throw err;
    }
  }

  private timestamp(): string {
    return new Date().toISOString().split('.')[0] + '.000Z';
  }

  /** Mask a secret for logs: show first/last 4 chars only. */
  private mask(v?: string): string {
    if (!v) return '';
    const s = String(v);
    return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-4)}`;
  }

  private logResponse(endpoint: string, status: any, data: any): void {
    let raw: string;
    try {
      raw = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      raw = '[unserializable]';
    }
    if (raw && raw.length > 1500) raw = raw.slice(0, 1500) + '…[truncated]';
    this.logger.log(
      `[Breeze RESP] ${endpoint} | status: ${status ?? 'n/a'} | body: ${raw}`,
    );
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
  private async get(
    endpoint: string,
    payload: Record<string, any>,
    retried = false,
  ): Promise<any> {
    await this.ensureSession();
    const body = JSON.stringify(payload ?? {});
    const headers = this.generateHeaders(body);
    this.logger.log(
      `[Breeze GET] ${this.baseUrl}${endpoint} | headers: ${JSON.stringify({
        'Content-Type': headers['Content-Type'],
        'X-AppKey': this.mask(headers['X-AppKey']),
        'X-SessionToken': this.mask(headers['X-SessionToken']),
        'X-Checksum': this.mask(headers['X-Checksum'].replace('token ', '')),
        'X-Timestamp': headers['X-Timestamp'],
      })} | body: ${body}`,
    );
    try {
      const { data, status } = await axios.request({
        method: 'GET',
        url: `${this.baseUrl}${endpoint}`,
        data: body,
        headers,
      });
      this.logResponse(endpoint, status, data);
      if (data && data.Error) {
        // Sprint 6.2.14 — "No Data Found" is an EMPTY successful result, not a
        // failure. Return [] (no throw, no warning, sync not marked failed) so
        // orders/trades/positions/holdings simply resolve to an empty list.
        if (isBreezeNoDataFound(data.Error)) {
          return [];
        }
        // Sprint 6.2.14 — a stale / invalid session refreshes ONCE and retries.
        if (!retried && isBreezeSessionError(data.Error)) {
          this.invalidateSession();
          await this.ensureSession(true);
          return this.get(endpoint, payload, true);
        }
        throw new Error(String(data.Error));
      }
      return data && data.Success !== undefined ? data.Success : data;
    } catch (err: any) {
      // Sprint 6.2.14 — refresh the cached session once on an Unauthorized /
      // invalid-session transport error, then retry the (idempotent) read.
      if (!retried && isBreezeSessionError(err)) {
        this.invalidateSession();
        await this.ensureSession(true);
        return this.get(endpoint, payload, true);
      }
      this.logResponse(
        endpoint,
        err?.response?.status,
        err?.response?.data ?? err?.message,
      );
      throw err;
    }
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
    // portfolioholdings requires exchange_code (NSE covers listed equity
    // holdings). Prefer the current market price the holdings API returns;
    // otherwise enrich LTP via the official quotes API. Value/P&L are computed
    // downstream in BrokerService (never fabricated).
    const raw = await this.get('portfolioholdings', { exchange_code: 'NSE' });
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    await Promise.all(
      items.map(async (h: any) => {
        if (!h) return;
        const cmp = Number(h.current_market_price ?? h.ltp);
        if (Number.isFinite(cmp) && cmp > 0) {
          h.ltp = cmp;
          return;
        }
        const ltp = await this.quoteLtp(
          h?.exchange_code ?? 'NSE',
          h?.stock_code,
          h?.product_type,
        );
        if (ltp !== null) h.ltp = ltp;
      }),
    );
    return items;
  }

  async getPositions() {
    const raw = await this.get('portfoliopositions', {});
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    await Promise.all(
      items.map(async (p: any) => {
        if (!p) return;
        const cmp = Number(p.ltp ?? p.current_market_price ?? p.last_traded_price);
        if (Number.isFinite(cmp) && cmp > 0) {
          p.ltp = cmp;
          return;
        }
        const ltp = await this.quoteLtp(
          p?.exchange_code ?? 'NSE',
          p?.stock_code,
          p?.product_type,
        );
        if (ltp !== null) p.ltp = ltp;
      }),
    );
    return items;
  }

  /** Best-effort live LTP via the official Breeze quotes endpoint (cached). */
  private async quoteLtp(
    exchange: string,
    stock: string,
    productType?: string,
  ): Promise<number | null> {
    if (!stock) return null;
    const exch = exchange || 'NSE';
    const product = productType ? String(productType).toLowerCase() : 'cash';
    const key = `${exch}|${stock}|${product}`;
    if (this.quoteCache.has(key)) return this.quoteCache.get(key) ?? null;
    let result: number | null = null;
    try {
      const q = await this.get('quotes', {
        stock_code: stock,
        exchange_code: exch,
        product_type: product,
      });
      const first = Array.isArray(q) ? q[0] : q;
      const ltp = first?.ltp ?? first?.last_traded_price ?? first?.close;
      const n = Number(ltp);
      result = Number.isFinite(n) ? n : null;
    } catch {
      result = null;
    }
    this.quoteCache.set(key, result);
    return result;
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
    // Portfolio summary is derived (shared logic) from enriched holdings.
    return this.getHoldings();
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

  /**
   * Authenticated Breeze write call (POST/PUT/DELETE) — same checksum-header
   * auth as `get()`, but with a mutating HTTP method. Breeze order placement,
   * modification and cancellation all target the `order` endpoint.
   */
  private async request(
    method: 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    payload: Record<string, any>,
  ): Promise<any> {
    await this.ensureSession();
    const body = JSON.stringify(payload ?? {});
    const headers = this.generateHeaders(body);
    this.logger.log(
      `[Breeze ${method}] ${this.baseUrl}${endpoint} | headers: ${JSON.stringify({
        'Content-Type': headers['Content-Type'],
        'X-AppKey': this.mask(headers['X-AppKey']),
        'X-SessionToken': this.mask(headers['X-SessionToken']),
        'X-Checksum': this.mask(headers['X-Checksum'].replace('token ', '')),
        'X-Timestamp': headers['X-Timestamp'],
      })} | body: ${body}`,
    );
    try {
      const { data, status } = await axios.request({
        method,
        url: `${this.baseUrl}${endpoint}`,
        data: body,
        headers,
      });
      this.logResponse(endpoint, status, data);
      if (data && data.Error) {
        throw new Error(String(data.Error));
      }
      return data && data.Success !== undefined ? data.Success : data;
    } catch (err: any) {
      this.logResponse(
        endpoint,
        err?.response?.status,
        err?.response?.data ?? err?.message,
      );
      throw err;
    }
  }

  /**
   * Breeze place_order (official Breeze API v1 `order` endpoint, POST).
   * `order` is the already-shaped Breeze payload built by the caller
   * (stock_code, exchange_code, product, action, order_type, quantity,
   * price, stoploss, validity, …). Returns the Breeze `Success` block,
   * which carries `order_id`.
   */
  async placeOrder(order: any) {
    return this.request('POST', 'order', order ?? {});
  }

  async modifyOrder(orderId: string, order: any) {
    return this.request('PUT', 'order', { ...(order ?? {}), order_id: orderId });
  }

  async cancelOrder(orderId: string, exchangeCode = 'NSE') {
    return this.request('DELETE', 'order', {
      order_id: orderId,
      exchange_code: exchangeCode,
    });
  }
}

// ---------------------------------------------------------------------------
// Sprint 6.2.14 — Breeze response classifiers (no functional change to payload,
// checksum, headers, auth or order placement).
// ---------------------------------------------------------------------------

/** Breeze "No Data Found" == a successful, empty result (not an error). */
function isBreezeNoDataFound(errText: unknown): boolean {
  return String(errText ?? '')
    .trim()
    .toLowerCase()
    .includes('no data found');
}

/** Detect an Unauthorized / invalid-session response that warrants a refresh. */
function isBreezeSessionError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const status = anyErr?.response?.status;
  if (status === 401 || status === 403) return true;
  const msg = String(
    anyErr?.response?.data?.Error ?? anyErr?.message ?? anyErr ?? '',
  ).toLowerCase();
  return (
    msg.includes('invalid session') ||
    msg.includes('session expired') ||
    msg.includes('session is invalid') ||
    msg.includes('unauthorized') ||
    msg.includes('unauthorised')
  );
}
