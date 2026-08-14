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
 * Sprint 6.2.0 — Shoonya (Finvasia Noren) OAuth adapter.
 *
 * Shoonya officially retired the password + TOTP `QuickAuth` login
 * (`/NorenWClientTP/QuickAuth`) and moved to an OAuth 2.0 authorization-code
 * flow on the new `/NorenWClientAPI/` base, per the official OAuth SDK
 * (github.com/Shoonya-API-OAuth-Python/Shoonya_API_OAuth) and the Noren OAuth
 * docs. This adapter mirrors the Fyers/Upstox OAuth adapters:
 *
 *   1. `getLoginUrl(state?)` → the hosted authorize URL
 *      `https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=<clientId>`.
 *      After the user logs in, Shoonya redirects to the app's registered
 *      redirect URI with `?code=<auth_code>`.
 *   2. `exchangeToken(code)` → POSTs `jData={code, checksum}` to
 *      `/NorenWClientAPI/GenAcsTok`, where
 *      `checksum = SHA256(apiKey + secretCode + code)` (no spaces). Returns the
 *      daily `access_token` (+ refresh_token / uid / actid / uname).
 *   3. Every authenticated read is a Noren POST of
 *      `jData=<json>&jKey=<access_token>` with an
 *      `Authorization: Bearer <access_token>` header (the OAuth access token
 *      replaces the legacy `susertoken`).
 *
 * Data endpoints (UserDetails, Limits, Holdings, PositionBook, OrderBook,
 * TradeBook, Logout) are unchanged from the Noren contract — only the base URL,
 * the login mechanism and the token header changed. The Sprint 6.1.8 network
 * resilience (retry + typed gateway-outage error on 502/HTML) is preserved.
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
    // Sprint 6.2.0 — OAuth is interactive (redirect + user login), so there is
    // no silent auto-login. A fresh OAuth login is required daily.
    supportsAutoLogin: false,
    supportsLogout: true,
    supportsSessionRefresh: false,
  };

  static readonly onboarding: BrokerOnboardingRequirements = {
    // Sprint 6.2.0 — migrated from QuickAuth (password/TOTP/vendor) to OAuth.
    requiresOAuth: true,
    requiresApiKey: true, // Shoonya OAuth API key (client_id).
    requiresSecret: true, // Shoonya OAuth secret code.
    requiresPassword: false,
    requiresPIN: false,
    requiresTOTP: false,
    requiresStaticIP: false,
    requiresRedirect: true,
    requiresVendorCode: false,
    supportsAutoLogin: false,
    supportsTokenRefresh: false,
    supportsMFA: false,
  };

  // Sprint 6.2.0 — new OAuth API host (QuickAuth on NorenWClientTP is retired).
  private readonly baseUrl = 'https://api.shoonya.com/NorenWClientAPI';
  private readonly oauthAuthorizeUrl =
    'https://api.shoonya.com/OAuthlogin/authorize/oauth';

  // Sprint 6.1.8 — network resilience against intermittent Noren gateway
  // failures (api.shoonya.com nginx front returns HTTP 502 / connection
  // resets during broker-side upstream flaps). These are transport-layer
  // failures, not request-format bugs.
  private readonly timeoutMs = 15000;
  private readonly maxAttempts = 3;

  // Per-account OAuth credentials (never env-based) — used only for the token
  // exchange checksum + the authorize URL. Authenticated reads use the token.
  private apiKey = '';
  private secretCode = '';

  private accessToken = '';
  private uid = '';
  private actid = '';

  /**
   * Sprint 6.2.0 — per-account OAuth credentials: `apiKey` is the Shoonya
   * OAuth Client ID (sent as `client_id` in the authorize URL and used as the
   * first checksum component), `secretCode` is the OAuth secret code. Trimmed
   * to drop copy-paste artefacts (trailing newline/spaces) that would otherwise
   * corrupt the authorize URL / checksum.
   */
  setCredentials(apiKey: string, secretCode: string) {
    this.apiKey = (apiKey ?? '').trim();
    this.secretCode = (secretCode ?? '').trim();
  }

  /**
   * The OAuth access token is what every authenticated Noren call carries
   * (as the `Authorization: Bearer` header and the `jKey` body field). Kept
   * named `setSessionToken` so the shared BrokerService adapter factory wiring
   * is unchanged (it treats the stored access token as the session token).
   */
  setSessionToken(token: string) {
    this.accessToken = token;
  }

  setAccessToken(token: string) {
    this.accessToken = token;
  }

  /** Sprint 6.1.6 — user/account id required by every Noren data endpoint. */
  setUserId(userId: string) {
    this.uid = userId;
    this.actid = userId;
  }

  getLoginUrl(state?: string): string {
    // Shoonya support confirmed the authorize endpoint parameter is `client_id`
    // (the value is the developer-portal Client ID, stored on the account as
    // its API key). NOTE: parameter NAME is client_id; the value is this.apiKey.
    const params = new URLSearchParams({ client_id: this.apiKey });
    // Shoonya may not echo `state` back on the callback; it is included as a
    // best-effort, self-contained reconnect-context carrier. The controller
    // always writes the cookie/map fallback too, so a dropped `state` is safe.
    if (state) params.set('state', state);
    return `${this.oauthAuthorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange the single-use OAuth authorization `code` for the daily access
   * token via `GenAcsTok`. `checksum = SHA256(apiKey + secretCode + code)`
   * (no spaces) per the official OAuth SDK/docs. Body is raw
   * `jData=<json>` (no jKey yet — there is no token before this call).
   */
  async exchangeToken(code: string): Promise<any> {
    if (!this.apiKey || !this.secretCode) {
      throw new Error(
        'Shoonya OAuth API key/secret code missing on this account.',
      );
    }
    const checksum = createHash('sha256')
      .update(`${this.apiKey}${this.secretCode}${code}`)
      .digest('hex');
    const jData = { code, checksum };
    const body = `jData=${JSON.stringify(jData)}`;
    const data = await this.httpPost(`${this.baseUrl}/GenAcsTok`, body);
    if (!data || data.stat !== 'Ok' || !data.access_token) {
      throw new Error(data?.emsg || 'Shoonya OAuth token exchange failed');
    }
    // Cache the token + account id so the immediately-following profile/data
    // calls on this adapter instance succeed.
    this.accessToken = data.access_token;
    this.setUserId(data.actid ?? data.uid ?? '');
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      uid: data.uid,
      actid: data.actid,
      userId: data.actid ?? data.uid,
      userName: data.uname,
      email: data.email,
      raw: data,
    };
  }

  /**
   * Resilient Noren HTTP POST (Sprint 6.1.8).
   *
   * Noren's gateway (nginx at api.shoonya.com) intermittently returns HTTP
   * 5xx **HTML** error pages and drops connections while its upstream flaps.
   * We therefore set an explicit timeout, retry transient failures with
   * backoff, and detect non-JSON (HTML) bodies → raise a typed, actionable
   * `SHOONYA_GATEWAY_UNAVAILABLE` error instead of leaking raw HTML.
   *
   * When `authToken` is supplied it is sent as `Authorization: Bearer <token>`
   * (Sprint 6.2.0 OAuth) — omitted for the unauthenticated GenAcsTok exchange.
   */
  private async httpPost(
    url: string,
    body: string,
    authToken?: string,
  ): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await axios.post(url, body, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
   * Core authenticated Noren POST helper. Every endpoint uses
   * `jData=<raw json>&jKey=<access_token>` (jData is NOT url-encoded) plus the
   * OAuth Bearer header (Sprint 6.2.0).
   */
  private async post(path: string, jData: Record<string, any>): Promise<any> {
    const body = `jData=${JSON.stringify(jData)}&jKey=${this.accessToken}`;
    const data = await this.httpPost(
      `${this.baseUrl}/${path}`,
      body,
      this.accessToken,
    );
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

  /** Sprint 6.2.0 — live authenticated probe used by post-persist validation. */
  async validateToken(): Promise<{ userId?: string }> {
    const data = await this.post('UserDetails', { uid: this.uid });
    return { userId: data?.actid ?? this.uid };
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
        'Shoonya (Noren) OAuth has no silent refresh; a fresh OAuth login is required daily.',
    };
  }

  /**
   * Sprint — Shoonya copy-execution translation + placement.
   *
   * Places an order on the Noren `PlaceOrder` endpoint. ALL Shoonya-specific
   * translation lives HERE (never in the copy-trading engine): the broker-
   * neutral order produced by the follower translator is mapped into the exact
   * Noren field set (uid/actid/exch/tsym/qty/prc/prd/trantype/prctyp/ret).
   *
   *   product   MIS/INTRADAY/I → 'I' · CNC/DELIVERY/C → 'C' · NRML/NORMAL/MARGIN/M → 'M'
   *   side      BUY → 'B' · SELL → 'S'
   *   orderType MARKET → 'MKT' (prc '0') · LIMIT → 'LMT' (prc from price)
   *
   * Ref: official ShoonyaApi-py / Noren place_order contract.
   */
  async placeOrder(order: any) {
    if (!this.accessToken) {
      throw new Error('Shoonya session token missing — reconnect the broker.');
    }
    if (!this.uid) {
      throw new Error('Shoonya account id (uid) missing on this session.');
    }

    const exch = String(order?.exchange ?? order?.exch ?? 'NSE').trim().toUpperCase();
    const tsym = String(order?.tradingSymbol ?? order?.tsym ?? order?.symbol ?? '').trim();
    if (!tsym) {
      throw new Error('Shoonya order is missing a trading symbol (tsym).');
    }

    const qtyNum = Number(order?.quantity ?? order?.qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      throw new Error(`Invalid quantity "${order?.quantity ?? order?.qty}" for Shoonya order.`);
    }

    const sideRaw = String(order?.side ?? order?.trantype ?? '').trim().toUpperCase();
    const trantype = sideRaw === 'SELL' || sideRaw === 'S' ? 'S' : 'B';

    const otRaw = String(order?.orderType ?? order?.prctyp ?? 'MARKET').trim().toUpperCase();
    const isLimit = otRaw === 'LIMIT' || otRaw === 'LMT';
    const prctyp = isLimit ? 'LMT' : 'MKT';

    const prd = ShoonyaAdapter.mapProduct(order?.product);
    if (!prd) {
      throw new Error(
        `Invalid product "${order?.product}" for Shoonya. ` +
          `Supported: MIS/INTRADAY, CNC/DELIVERY, NRML/NORMAL.`,
      );
    }

    const priceNum = Number(order?.price ?? order?.prc ?? 0);
    const prc = isLimit && Number.isFinite(priceNum) ? String(priceNum) : '0';

    const ret = String(order?.validity ?? order?.ret ?? 'DAY').trim().toUpperCase();

    const jData: Record<string, any> = {
      uid: this.uid,
      actid: this.actid || this.uid,
      exch,
      tsym,
      qty: String(Math.trunc(qtyNum)),
      prc,
      prd,
      trantype,
      prctyp,
      ret,
      ordersource: 'API',
    };

    return this.post('PlaceOrder', jData);
  }

  /**
   * Map a CTS-internal / cross-broker product onto a Noren product code, or
   * null when unresolvable (the caller rejects BEFORE the broker API call).
   */
  static mapProduct(product: unknown): 'C' | 'M' | 'I' | null {
    const p = String(product ?? '').trim().toUpperCase();
    switch (p) {
      case 'MIS':
      case 'INTRADAY':
      case 'I':
        return 'I';
      case 'CNC':
      case 'DELIVERY':
      case 'C':
        return 'C';
      case 'NRML':
      case 'NORMAL':
      case 'MARGIN':
      case 'M':
        return 'M';
      default:
        return null;
    }
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
      `This is a broker-side outage, not a problem with your OAuth API key or secret. Please retry in a few minutes.`,
  );
  (err as any).error_type = 'SHOONYA_GATEWAY_UNAVAILABLE';
  (err as any).brokerStatus = status || undefined;
  return err;
}
