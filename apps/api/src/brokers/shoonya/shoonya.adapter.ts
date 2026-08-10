import axios from 'axios';
import {
  BrokerAdapter,
  BrokerCapabilities,
  BrokerFeatureSupport,
  BrokerOnboardingRequirements,
  BrokerProfile,
  UnsupportedResult,
} from '../broker.interface';

/**
 * Sprint 6.1.6 — Full Shoonya (Finvasia Noren) adapter.
 *
 * Noren REST endpoints are POST calls with a body of
 * `jData=<json>&jKey=<susertoken>` (application/x-www-form-urlencoded). Data
 * endpoints require `uid` and `actid` in jData, both derived from the stored
 * account user id (== Noren account id for retail accounts). Every documented
 * account endpoint is wired: UserDetails, Limits, Holdings, PositionBook,
 * OrderBook, TradeBook, Logout.
 */
export class ShoonyaAdapter implements BrokerAdapter {
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
    supportsAutoLogin: true,
    supportsLogout: true,
    supportsSessionRefresh: false,
  };

  static readonly onboarding: BrokerOnboardingRequirements = {
    requiresOAuth: false,
    requiresApiKey: true,
    requiresSecret: false,
    requiresPassword: true,
    requiresPIN: false,
    requiresTOTP: true,
    requiresStaticIP: false,
    requiresRedirect: false,
    requiresVendorCode: true,
    supportsAutoLogin: true,
    supportsTokenRefresh: false,
    supportsMFA: true,
  };

  private readonly baseUrl = 'https://api.shoonya.com/NorenWClientTP';
  // Sprint 6.1.8 — network resilience against intermittent Noren gateway
  // failures (api.shoonya.com nginx front returns HTTP 502 / connection
  // resets during broker-side upstream flaps). Verified via direct curl: the
  // endpoint + request format match the official ShoonyaApi-py SDK exactly, so
  // these are transport-layer failures, not request-format bugs.
  private readonly timeoutMs = 15000;
  private readonly maxAttempts = 3;
  private sessionToken = '';
  private uid = '';
  private actid = '';

  setSessionToken(token: string) {
    this.sessionToken = token;
  }

  /** Sprint 6.1.6 — user/account id required by every Noren data endpoint. */
  setUserId(userId: string) {
    this.uid = userId;
    this.actid = userId;
  }

  getLoginUrl(): string {
    // Shoonya uses direct API login (credentials + TOTP), not OAuth.
    return '';
  }

  async exchangeToken(_: string): Promise<any> {
    throw new Error('Shoonya does not support OAuth token exchange.');
  }

  /**
   * Resilient Noren HTTP POST (Sprint 6.1.8).
   *
   * Noren's gateway (nginx at api.shoonya.com) intermittently returns HTTP
   * 5xx **HTML** error pages and drops connections while its upstream flaps.
   * We therefore:
   *   - set an explicit timeout (never hang a login request forever),
   *   - retry transient failures (5xx / network reset / timeout) with backoff,
   *   - DETECT non-JSON (HTML) gateway bodies and raise a typed, actionable
   *     `SHOONYA_GATEWAY_UNAVAILABLE` error instead of leaking raw HTML.
   * `validateStatus: () => true` lets us inspect the status + body ourselves
   * rather than have axios throw an opaque error on 5xx.
   */
  private async httpPost(url: string, body: string): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await axios.post(url, body, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          timeout: this.timeoutMs,
          validateStatus: () => true,
          transformResponse: [(d) => d], // keep raw so we can classify HTML
        });

        const status = res.status;
        const contentType = String(res.headers?.['content-type'] ?? '');
        const raw = res.data;
        const looksHtml =
          contentType.includes('text/html') ||
          (typeof raw === 'string' && /^\s*<(?:!doctype|html)/i.test(raw));

        // Gateway / upstream failure → retry, then surface a clear message.
        if (status >= 500 || looksHtml) {
          lastError = gatewayUnavailableError(status, raw);
          if (attempt < this.maxAttempts) {
            await delay(attempt * 700);
            continue;
          }
          throw lastError;
        }

        // Parse the JSON body ourselves (transformResponse kept it raw).
        if (typeof raw === 'string') {
          try {
            return raw.length ? JSON.parse(raw) : {};
          } catch {
            // A 2xx that is not valid JSON is still a gateway/content problem.
            throw gatewayUnavailableError(status, raw);
          }
        }
        return raw;
      } catch (err: any) {
        // Network-level failures (ECONNRESET / ETIMEDOUT / socket hang up).
        if (isRetryableNetworkError(err)) {
          lastError = err;
          if (attempt < this.maxAttempts) {
            await delay(attempt * 700);
            continue;
          }
          throw gatewayUnavailableError(0, err?.message ?? 'network error');
        }
        throw err;
      }
    }

    throw lastError ?? new Error('Shoonya request failed');
  }

  /**
   * Core Noren POST helper. Every authenticated endpoint uses
   * `jData=<raw json>&jKey=<susertoken>` with an explicit
   * application/x-www-form-urlencoded content type — matching the official
   * NorenApi client exactly (jData is NOT url-encoded).
   */
  private async post(path: string, jData: Record<string, any>): Promise<any> {
    const body = `jData=${JSON.stringify(jData)}&jKey=${this.sessionToken}`;
    const data = await this.httpPost(`${this.baseUrl}/${path}`, body);
    if (Array.isArray(data)) return data;
    if (data && data.stat && data.stat !== 'Ok') {
      const emsg = String(data.emsg ?? '');
      // Noren returns Not_ok + "no data"/"no record" for genuinely empty
      // books — treat that as an empty result, not an error (no fabrication).
      if (/no data|no record|not found|no.*position|no.*holding/i.test(emsg)) {
        return [];
      }
      throw new Error(emsg || `Shoonya error on ${path}`);
    }
    return data;
  }

  /**
   * Noren QuickAuth login. `pwd` must be SHA-256(password), `appkey` must be
   * SHA-256("{uid}|{api_secret}"), `factor2` is the current TOTP — the caller
   * (ShoonyaService) computes these. Body is raw `jData=<json>` (no jKey yet).
   * On success the susertoken + uid/actid are cached on the adapter so the
   * immediately-following profile/data calls succeed.
   */
  async login(payload: {
    uid: string;
    pwd: string;
    factor2: string;
    vc: string;
    appkey: string;
  }) {
    const jData = {
      source: 'API',
      apkversion: '1.0.0',
      uid: payload.uid,
      pwd: payload.pwd,
      factor2: payload.factor2,
      vc: payload.vc,
      appkey: payload.appkey,
      imei: 'CTS_SERVER',
    };
    const body = `jData=${JSON.stringify(jData)}`;
    const data = await this.httpPost(`${this.baseUrl}/QuickAuth`, body);
    if (!data || data.stat !== 'Ok' || !data.susertoken) {
      throw new Error(data?.emsg || 'Shoonya login failed');
    }
    // Persist session state so getProfile()/data calls work on this instance.
    this.sessionToken = data.susertoken;
    this.setUserId(data.actid ?? payload.uid);
    return data;
  }

  async getProfile(): Promise<BrokerProfile> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return {
      broker: 'SHOONYA',
      userId: data.actid ?? this.uid,
      userName: data.uname ?? '',
      email: data.email ?? '',
      exchanges: Array.isArray(data.exarr) ? data.exarr : undefined,
      accountType: data.actid ? 'INDIVIDUAL' : undefined,
      profileStatus: data.stat === 'Ok' ? 'ACTIVE' : undefined,
    };
  }

  async getMargins() {
    return this.post('Limits', { uid: this.uid, actid: this.actid });
  }

  async getFunds() {
    return this.post('Limits', { uid: this.uid, actid: this.actid });
  }

  async getHoldings() {
    // prd = product type; 'C' (CNC) is the standard delivery holdings product.
    return this.post('Holdings', {
      uid: this.uid,
      actid: this.actid,
      prd: 'C',
    });
  }

  async getPositions() {
    return this.post('PositionBook', { uid: this.uid, actid: this.actid });
  }

  async getOrders() {
    return this.post('OrderBook', { uid: this.uid });
  }

  async getTrades() {
    return this.post('TradeBook', { uid: this.uid, actid: this.actid });
  }

  async getPortfolio() {
    return this.getHoldings();
  }

  async getExchanges(): Promise<string[] | null> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return Array.isArray(data.exarr) ? data.exarr : null;
  }

  async getProducts(): Promise<string[] | null> {
    return null; // Not distinctly enumerated by the Noren profile payload.
  }

  async logout(): Promise<UnsupportedResult | { supported: true; data?: any }> {
    const data = await this.post('Logout', { uid: this.uid });
    return { supported: true, data };
  }

  async refreshSession(): Promise<
    UnsupportedResult | { supported: true; data?: any }
  > {
    return {
      supported: false,
      reason:
        'Shoonya (Noren) has no token refresh; a fresh TOTP login is required daily.',
    };
  }

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

/** Small async delay used for retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Axios/node network errors that are safe to retry (transient transport). */
function isRetryableNetworkError(err: any): boolean {
  const code = String(err?.code ?? '').toUpperCase();
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNREFUSED'
  ) {
    return true;
  }
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
}

/**
 * Build a clear, actionable error for a Noren gateway/upstream failure so CTS
 * surfaces a human message (never a raw HTML blob). `status` 0 == no HTTP
 * response (network failure). Carries `error_type` + `brokerStatus` so callers
 * can distinguish a broker outage from a credential rejection.
 */
function gatewayUnavailableError(status: number, rawBody: unknown): Error {
  const isHtml =
    typeof rawBody === 'string' && /<(?:!doctype|html|center|title)/i.test(rawBody);
  const statusText =
    status === 502
      ? 'HTTP 502 Bad Gateway'
      : status === 503
      ? 'HTTP 503 Service Unavailable'
      : status === 504
      ? 'HTTP 504 Gateway Timeout'
      : status >= 500
      ? `HTTP ${status}`
      : status === 0
      ? 'no response (connection failed/timed out)'
      : `HTTP ${status}`;

  const detail = isHtml ? ' (received an HTML gateway page, not a JSON API response)' : '';
  const err = new Error(
    `Shoonya (Finvasia Noren) API gateway at api.shoonya.com is temporarily unavailable — ${statusText}${detail}. ` +
      `This is a broker-side outage, not a problem with your UID, password, TOTP or API key. Please retry in a few minutes.`,
  );
  (err as any).error_type = 'SHOONYA_GATEWAY_UNAVAILABLE';
  (err as any).brokerStatus = status || undefined;
  return err;
}
